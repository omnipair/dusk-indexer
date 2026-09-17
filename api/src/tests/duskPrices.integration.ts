import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { PoolClient } from 'pg';
import pool from '../config/database';
import { loadPinnedProtocol } from '../config/duskProtocol';
import { projectPriceCapture, projectPriceCaptureBatch, readDuskPriceHistory, storePriceCapture } from '../services/duskPrices';
import { priceFixture } from './duskPriceFixtures';

if (process.env.DUSK_ALLOW_DISPOSABLE_DB_TESTS !== 'true' || !process.env.DATABASE_URL) throw new Error('A disposable DATABASE_URL is required');
after(() => pool.end());
const pin = loadPinnedProtocol(),active = [pin.cluster,pin.dusk.programId,pin.dusk.idlCanonicalSha256,pin.revision];
async function transaction(work: (client: PoolClient) => Promise<void>) {
  const client = await pool.connect();
  try { await client.query('BEGIN'); await client.query(`INSERT INTO dusk_ingestion.protocol_identities(cluster,program_id,idl_hash,protocol_revision)
    VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,active); await work(client); }
  finally { await client.query('ROLLBACK'); client.release(); }
}
const query = (mint: string,at = '2026-09-02T00:00:00Z') => ({ mint,at,maxAgeSeconds: 3600,limit: 100,offset: 0 });

test('legacy raw-account and post-simulation price captures replay with their original hashes',() => transaction(async (client) => {
  const fixture = priceFixture(),legacy = fixture.source();
  legacy.marketSlot--;
  const oldId = await storePriceCapture(client,legacy);
  const simulated = { ...fixture.source(legacy.slot+1),marketStateBasis: 'simulation-post-state' as const };
  const newId = await storePriceCapture(client,simulated);
  assert.equal(await projectPriceCapture(client,oldId),2);
  assert.equal(await projectPriceCapture(client,newId),2);
  const saved = await client.query('SELECT market_state_basis FROM dusk_ingestion.price_capture_observations WHERE capture_id=ANY($1::bigint[]) ORDER BY capture_id',[[oldId,newId]]);
  assert.deepEqual(saved.rows.map((row) => row.market_state_basis),['rpc-account','simulation-post-state']);
  assert.equal(await storePriceCapture(client,{ ...simulated,observedAt: '2026-09-02T00:00:10Z' }),newId);
  await assert.rejects(storePriceCapture(client,{ ...simulated,marketSlot: simulated.slot-1 }),/share the preview slot/);
  await client.query('SAVEPOINT invalid_basis');
  await assert.rejects(client.query(`INSERT INTO dusk_ingestion.price_capture_observations
    (cluster,program_id,idl_hash,protocol_revision,market,slot,market_slot,blockhash,block_time,observed_at,
     deployment_identity_sha256,raw_market,raw_preview,reference_config,content_hash,preview_hash,market_state_basis)
    SELECT cluster,program_id,idl_hash,protocol_revision,market,slot,market_slot-1,blockhash,block_time,observed_at,
      deployment_identity_sha256,raw_market,raw_preview,reference_config,content_hash,preview_hash,market_state_basis
    FROM dusk_ingestion.price_capture_observations WHERE capture_id=$1`,[newId]),/dusk_price_simulated_market_slot/);
  await client.query('ROLLBACK TO SAVEPOINT invalid_basis');
}));

test('saved quotes replay once, and a later configured price cannot rewrite earlier history',() => transaction(async (client) => {
  const fixture = priceFixture(),source = fixture.source(),first = await storePriceCapture(client,source);
  assert.equal(await storePriceCapture(client,{ ...source,observedAt: '2026-09-02T00:00:10Z' }),first);
  assert.equal(await projectPriceCaptureBatch(client),1);
  assert.equal(await projectPriceCaptureBatch(client),0);
  const before = await readDuskPriceHistory(client,query(fixture.baseMint));
  assert.equal(before.observations[0].priceUsd,'2.5');
  const newer = priceFixture({ price: '3' }).source(source.slot+1);
  newer.blockTime = '2026-09-02T00:01:00Z'; newer.observedAt = '2026-09-02T00:01:05Z';
  await projectPriceCapture(client,await storePriceCapture(client,newer));
  const after = await readDuskPriceHistory(client,query(fixture.baseMint));
  assert.deepEqual(after.observations,before.observations);
  assert.equal((await readDuskPriceHistory(client,query(fixture.baseMint,'2026-09-02T00:01:00Z'))).observations[0].priceUsd,'7.5');
}));
test('older-slot backfill and different slots sharing one timestamp both survive replay',() => transaction(async (client) => {
  const fixture = priceFixture(),first = fixture.source();
  await projectPriceCapture(client,await storePriceCapture(client,first));
  await storePriceCapture(client,priceFixture({ quoteNad: 3_000_000_000n }).source(first.slot-1));
  assert.equal(await projectPriceCaptureBatch(client),1);
  const history = await readDuskPriceHistory(client,query(fixture.baseMint));
  assert.equal(history.pagination.total,2);
  assert.equal(history.observations[0].priceUsd,'2.5');
}));
test('missing, stale and future observations are not turned into usable prices',() => transaction(async (client) => {
  const fixture = priceFixture({ references: false }),id = await storePriceCapture(client,fixture.source());
  assert.equal(await projectPriceCapture(client,id),0);
  assert.equal(await projectPriceCaptureBatch(client),0);
  assert.equal((await readDuskPriceHistory(client,query(fixture.baseMint))).coverage.available,false);
  const priced = priceFixture().source(fixture.source().slot+1);
  await projectPriceCapture(client,await storePriceCapture(client,priced));
  assert.equal((await readDuskPriceHistory(client,query(fixture.baseMint,'2026-09-01T23:59:59Z'))).coverage.available,false);
  assert.equal((await readDuskPriceHistory(client,query(fixture.baseMint,'2026-09-02T02:00:00Z'))).coverage.available,false);
}));
test('contradictory finalized previews retain both sources and stop projection and reads',() => transaction(async (client) => {
  const first = await storePriceCapture(client,priceFixture().source());
  await projectPriceCapture(client,first);
  const conflicting = await storePriceCapture(client,priceFixture({ quoteNad: 3_000_000_000n }).source());
  await assert.rejects(projectPriceCapture(client,conflicting),/FINALIZED_INVARIANT/);
  await assert.rejects(readDuskPriceHistory(client,query(priceFixture().baseMint)),/FINALIZED_INVARIANT/);
  assert.equal((await client.query('SELECT count(*)::int AS total FROM dusk_ingestion.price_capture_observations WHERE capture_id=ANY($1::bigint[])',[[first,conflicting]])).rows[0].total,2);
}));
test('database source guard rejects a price with substituted source coordinates',() => transaction(async (client) => {
  const id = await storePriceCapture(client,priceFixture().source());
  await projectPriceCapture(client,id);
  await client.query('SAVEPOINT invalid_price');
  await assert.rejects(client.query(`INSERT INTO dusk_ingestion.price_observations
    (cluster,program_id,idl_hash,protocol_revision,mint,decimals,observed_at,source_time,price_usd,quality,source,source_evidence,capture_id)
    SELECT cluster,program_id,idl_hash,protocol_revision,mint,decimals,observed_at,source_time-interval '1 second',price_usd,quality,source,source_evidence,capture_id
    FROM dusk_ingestion.price_observations WHERE capture_id=$1`,[id]),/FINALIZED_INVARIANT/);
  await client.query('ROLLBACK TO SAVEPOINT invalid_price');
}));

test('database preserves full decimal precision and rejects changed prices and historical updates',() => transaction(async (client) => {
  const fixture = priceFixture({ price: '1.123456789',quoteNad: 1_234_567_891n }),id = await storePriceCapture(client,fixture.source());
  await projectPriceCapture(client,id);
  assert.equal((await readDuskPriceHistory(client,query(fixture.baseMint))).observations[0].priceUsd,'1.386983678625361999');
  await client.query('SAVEPOINT changed_price');
  await assert.rejects(client.query(`INSERT INTO dusk_ingestion.price_observations
    (cluster,program_id,idl_hash,protocol_revision,mint,decimals,observed_at,source_time,price_usd,quality,source,source_evidence,capture_id)
    SELECT cluster,program_id,idl_hash,protocol_revision,mint,decimals,observed_at,source_time,price_usd+1,quality,source,source_evidence,capture_id
    FROM dusk_ingestion.price_observations WHERE capture_id=$1`,[id]),/FINALIZED_INVARIANT/);
  await client.query('ROLLBACK TO SAVEPOINT changed_price');
  await assert.rejects(client.query('UPDATE dusk_ingestion.price_observations SET price_usd=1 WHERE capture_id=$1',[id]),/FINALIZED_INVARIANT/);
  await client.query('ROLLBACK TO SAVEPOINT changed_price');
}));
