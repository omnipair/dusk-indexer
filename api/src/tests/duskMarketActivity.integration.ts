/** Disposable PostgreSQL only: all event, projection and price fixtures roll back. */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { PoolClient } from 'pg';
import pool from '../config/database';
import { loadPinnedProtocol } from '../config/duskProtocol';
import { projectMarketActivityBatch, readMarketActivity } from '../services/duskMarketActivity';
import { projectPriceCapture, storePriceCapture } from '../services/duskPrices';
import { activityMarket, activityPayload, activitySlot, activityTime } from './duskActivityFixtures';
import { priceFixture } from './duskPriceFixtures';
import { fixtureKey } from './duskYieldCheckpointFixtures';
import { storeCaptureDeployment } from '../services/duskHistoryDeployment';
import { historyDeploymentFixture } from './duskHistoryDeploymentFixtures';

if (process.env.DUSK_ALLOW_DISPOSABLE_DB_TESTS !== 'true' || !process.env.DATABASE_URL)
  throw new Error('Set DUSK_ALLOW_DISPOSABLE_DB_TESTS=true and a disposable DATABASE_URL');
after(() => pool.end());
const pin = loadPinnedProtocol(),active = [pin.cluster,pin.dusk.programId,pin.dusk.idlCanonicalSha256,pin.revision];
const query = { market: activityMarket,since: '2026-09-02T00:00:00Z',until: '2026-09-02T00:01:00Z',
  deploymentIdentitySha256: 'b'.repeat(64),maxPriceAgeSeconds: 60 };

async function source(client: PoolClient,options: {
  slot?: number; name?: string; commitment?: string; revision?: string; fields?: Record<string,unknown>; time?: string; omitStream?: boolean;
} = {}) {
  const slot = options.slot ?? activitySlot,name = options.name ?? 'SwapExecuted';
  const id = [...active.slice(0,3),options.revision ?? active[3]];
  const fields = options.fields ?? activityPayload(name,slot),commitment = options.commitment ?? 'finalized';
  const eventKey = createHash('sha256').update(randomUUID()).digest('hex'),signature = `fixture-${eventKey}`;
  await client.query(`INSERT INTO dusk_ingestion.protocol_identities(cluster,program_id,idl_hash,protocol_revision)
    VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,id);
  const inserted = await client.query(`INSERT INTO dusk_ingestion.event_observations
    (cluster,program_id,idl_hash,protocol_revision,event_key,transaction_signature,instruction_path,event_ordinal,
      slot,blockhash,commitment,event_name,payload_hash,decoded_payload,source)
    VALUES($1,$2,$3,$4,$5,$6,'{0,1}',0,$7,$8,$9,$10,$11,$12,'disposable-integration-fixture') RETURNING observation_id`,
    [...id,eventKey,signature,slot,fixtureKey(130).toBase58(),commitment,name,
      createHash('sha256').update(JSON.stringify(fields)).digest('hex'),JSON.stringify(fields)]);
  await client.query(`INSERT INTO dusk_ingestion.canonical_events
    (cluster,program_id,idl_hash,protocol_revision,event_key,observation_id,commitment) VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [...id,eventKey,inserted.rows[0].observation_id,commitment]);
  if (!options.omitStream) await client.query(`INSERT INTO dusk_ingestion.event_stream
    (time,cluster,program_id,event_name,market,transaction_signature,event_key,slot,payload,idl_hash,protocol_revision)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [options.time ?? activityTime,id[0],id[1],name,fields.market,signature,eventKey,slot,JSON.stringify(fields),id[2],id[3]]);
  return eventKey;
}
async function transaction(work: (client: PoolClient) => Promise<void>) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await client.query(`INSERT INTO dusk_ingestion.protocol_identities(cluster,program_id,idl_hash,protocol_revision)
      VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,active);
    while (await projectMarketActivityBatch(client) === 500) { /* drain existing sources inside the rollback */ }
    await work(client);
  } finally { await client.query('ROLLBACK'); client.release(); }
}
async function rejectsAtSavepoint(client: PoolClient,operation: () => Promise<unknown>,message = /FINALIZED_INVARIANT/) {
  await client.query('SAVEPOINT expected_failure');
  await assert.rejects(operation(),message);
  await client.query('ROLLBACK TO SAVEPOINT expected_failure');
}
async function priced(client: PoolClient) {
  const id = await storePriceCapture(client,priceFixture().source());
  await projectPriceCapture(client,id);
  return id;
}
test('API-only releases preserve verified historical USD pricing for activity',() => transaction(async client => {
  const original = historyDeploymentFixture('fixture-old-price-worker'),deployment = historyDeploymentFixture();
  const capture = priceFixture().source();
  capture.deploymentIdentitySha256 = original.deploymentIdentitySha256;
  const id = await storePriceCapture(client,capture);
  await projectPriceCapture(client,id);
  await source(client);
  await projectMarketActivityBatch(client);
  const selection = { ...query,deployment,deploymentIdentitySha256: deployment.deploymentIdentitySha256 };
  assert.equal((await readMarketActivity(client,selection)).metrics.volume.observedUsd,null);
  await storeCaptureDeployment(client,original);
  assert.equal((await readMarketActivity(client,selection)).metrics.volume.observedUsd,'5');
}));

test('finalized native trades project once, exclude other revisions and commitments, and retain late backfills',() => transaction(async (client) => {
  await priced(client);
  await source(client);
  await source(client,{ commitment: 'confirmed' });
  await source(client,{ revision: `fixture-other-${randomUUID()}` });
  await source(client,{ name: 'YieldClaimed' });
  assert.equal(await projectMarketActivityBatch(client),1);
  assert.equal(await projectMarketActivityBatch(client),0);
  const before = await readMarketActivity(client,query);
  assert.equal(before.events,1); assert.equal(before.swaps,1);
  assert.equal(before.metrics.volume.observedUsd,'5');
  assert.equal(before.metrics.swapFees.observedUsd,'0.13');
  assert.equal(before.coverage.projectionComplete,true);
  assert.equal(before.coverage.historyRangeComplete,false);
  assert.equal(before.coverage.totalInterestAccrualAvailable,false);
  assert.equal(before.coverage.feeAllocationAvailable,false);
  assert.equal(before.coverage.priceBasis,'latest-captured-prior-slot.v1');
  await source(client,{ slot: activitySlot-1,time: '2026-09-02T00:00:05Z' });
  assert.equal(await projectMarketActivityBatch(client),1);
  const after = await readMarketActivity(client,query);
  assert.equal(after.events,2); assert.equal(after.metrics.volume.observedUsd,'10');
  assert.equal(after.coverage.firstSourceSlot,String(activitySlot-1));
  assert.notEqual(after.coverage.selectionHash,before.coverage.selectionHash);
  assert.equal((await readMarketActivity(client,{ ...query,since: activityTime })).events,1);
  assert.equal((await readMarketActivity(client,query)).coverage.selectionHash,after.coverage.selectionHash);
}));

test('leverage swaps, margin-only changes and reported interest are distinct economic observations',() => transaction(async (client) => {
  await priced(client);
  for (const name of ['LeveragePositionOpened','LeveragePositionUpdated','LeveragePositionClosed','LeveragePositionLiquidated','MarketDebtUpdated','HlpClosed','HlpTerminalLiquidated'])
    await source(client,{ name,fields: name === 'LeveragePositionUpdated' ? { ...activityPayload(name),swap: null } : undefined });
  assert.equal(await projectMarketActivityBatch(client),7);
  const view = await readMarketActivity(client,query);
  assert.equal(view.events,7); assert.equal(view.swaps,3);
  assert.equal(view.metrics.volume.observedUsd,'15');
  assert.equal(view.metrics.swapFees.observedUsd,'0.39');
  assert.equal(view.metrics.reportedInterest.observedUsd,'1.25');
  assert.equal(view.metrics.reportedInterest.observations,5);
}));

test('missing event-time evidence reports a backlog and a bad source rolls back the entire batch',() => transaction(async (client) => {
  await source(client);
  await source(client,{ slot: activitySlot+1,omitStream: true });
  const before = await readMarketActivity(client,query);
  assert.equal(before.coverage.pendingEvents,'2'); assert.equal(before.coverage.projectionComplete,false);
  await rejectsAtSavepoint(client,() => projectMarketActivityBatch(client));
  assert.equal((await readMarketActivity(client,query)).events,0);
}));

test('contradictory event timestamps stop both projection and reads of a previously projected event',() => transaction(async (client) => {
  const key = await source(client);
  assert.equal(await projectMarketActivityBatch(client),1);
  await client.query(`INSERT INTO dusk_ingestion.event_stream
    (time,cluster,program_id,event_name,market,transaction_signature,event_key,slot,payload,idl_hash,protocol_revision)
    SELECT time+interval '1 second',cluster,program_id,event_name,market,transaction_signature,event_key,slot,payload,idl_hash,protocol_revision
    FROM dusk_ingestion.event_stream WHERE event_key=$1`,[key]);
  await assert.rejects(readMarketActivity(client,query),/recorded activity source changed/);
  await rejectsAtSavepoint(client,() => client.query(`INSERT INTO dusk_ingestion.market_activity_events
    SELECT * FROM dusk_ingestion.market_activity_events WHERE event_key=$1`,[key]));
}));

test('the database rejects substituted activity fields and keeps projected records immutable',() => transaction(async (client) => {
  const key = await source(client);
  await rejectsAtSavepoint(client,() => client.query(`INSERT INTO dusk_ingestion.market_activity_events
    (cluster,program_id,idl_hash,protocol_revision,event_key,observation_id,event_name,market,signature,slot,blockhash,block_time,payload)
    SELECT c.cluster,c.program_id,c.idl_hash,c.protocol_revision,c.event_key,c.observation_id,o.event_name,$2,
      o.transaction_signature,o.slot,o.blockhash,s.time,o.decoded_payload
    FROM dusk_ingestion.canonical_events c
    JOIN dusk_ingestion.event_observations o USING(cluster,program_id,idl_hash,protocol_revision,event_key,observation_id)
    JOIN dusk_ingestion.event_stream s USING(cluster,program_id,idl_hash,protocol_revision,event_key)
    WHERE c.event_key=$1`,[key,fixtureKey(1).toBase58()]));
  await projectMarketActivityBatch(client);
  await rejectsAtSavepoint(client,() => client.query('UPDATE dusk_ingestion.market_activity_events SET slot=slot+1 WHERE event_key=$1',[key]));
  await rejectsAtSavepoint(client,() => client.query('DELETE FROM dusk_ingestion.market_activity_events WHERE event_key=$1',[key]));
}));

test('an unpriced trade makes the observed total unknown while retaining the separately labelled valued subtotal',() => transaction(async (client) => {
  await priced(client);
  await source(client,{ slot: activitySlot-10 }); // before the first price capture
  await source(client);
  await projectMarketActivityBatch(client);
  const view = await readMarketActivity(client,query);
  assert.equal(view.metrics.volume.observedUsd,null);
  assert.equal(view.metrics.volume.valuedUsd,'5');
  assert.equal(view.metrics.volume.unpricedObservations,1);
  assert.equal(view.metrics.volume.observations,2);
  assert.equal(view.markets[0].metrics.volume.observedUsd,null);
}));

test('same-slot, future-time and other-deployment captures cannot replace a historical trade price',() => transaction(async (client) => {
  await priced(client);
  await storePriceCapture(client,priceFixture({ price: '2' }).source(activitySlot));
  await storePriceCapture(client,{ ...priceFixture({ price: '3' }).source(activitySlot-1),deploymentIdentitySha256: 'c'.repeat(64) });
  await storePriceCapture(client,{ ...priceFixture({ price: '4' }).source(activitySlot-2),
    blockTime: '2026-09-02T00:00:11Z',observedAt: '2026-09-02T00:00:12Z' });
  await source(client); await projectMarketActivityBatch(client);
  assert.equal((await readMarketActivity(client,query)).metrics.volume.observedUsd,'5');
  assert.equal((await readMarketActivity(client,{ ...query,deploymentIdentitySha256: 'd'.repeat(64) })).metrics.volume.observedUsd,null);
  assert.equal((await readMarketActivity(client,{ ...query,maxPriceAgeSeconds: 9 })).metrics.volume.observedUsd,null);
}));

test('the newest captured policy is used even before its price worker runs; an empty policy cannot revive an older price',() => transaction(async (client) => {
  await priced(client);
  await storePriceCapture(client,priceFixture({ price: '2' }).source(activitySlot-2));
  await source(client); await projectMarketActivityBatch(client);
  const before = await readMarketActivity(client,query);
  assert.equal(before.metrics.volume.observedUsd,'10');
  await storePriceCapture(client,priceFixture({ references: false }).source(activitySlot-1));
  const after = await readMarketActivity(client,query);
  assert.equal(after.metrics.volume.observedUsd,null);
  assert.notEqual(after.coverage.selectionHash,before.coverage.selectionHash);
}));

test('contradictory captured prices halt activity reads without deleting either source',() => transaction(async (client) => {
  await priced(client);
  await source(client); await projectMarketActivityBatch(client);
  await storePriceCapture(client,priceFixture({ price: '2' }).source());
  await assert.rejects(readMarketActivity(client,query),/contradictory activity price evidence/);
}));

test('an invalid latest capture fails the read instead of falling back to an older valid quote',() => transaction(async (client) => {
  await priced(client);
  await storePriceCapture(client,{ ...priceFixture().source(activitySlot-1),rawPreview: Buffer.from('invalid preview').toString('base64') });
  await source(client); await projectMarketActivityBatch(client);
  await assert.rejects(readMarketActivity(client,query));
}));

test('500-row keyset pages retain every event sharing a slot and expose partial projection coverage',() => transaction(async (client) => {
  await priced(client);
  for (let i=0;i<503;i++) await source(client);
  assert.equal(await projectMarketActivityBatch(client),500);
  const partial = await readMarketActivity(client,query);
  assert.equal(partial.events,500); assert.equal(partial.coverage.projectionComplete,false);
  assert.equal(partial.coverage.pendingEvents,'3');
  assert.equal(await projectMarketActivityBatch(client),3);
  assert.equal(await projectMarketActivityBatch(client),0);
  const view = await readMarketActivity(client,query);
  assert.equal(view.events,503); assert.equal(view.swaps,503);
  assert.equal(view.metrics.volume.observedUsd,'2515');
  assert.equal(view.metrics.swapFees.observedUsd,'65.39');
  assert.equal(view.coverage.projectionComplete,true);
}));

test('selection identity binds market and normalized time filters, including empty windows',() => transaction(async (client) => {
  const first = await readMarketActivity(client,query);
  const equivalent = await readMarketActivity(client,{ ...query,since: '2026-09-02T00:00:00.000Z' });
  assert.equal(first.coverage.selectionHash,equivalent.coverage.selectionHash);
  const other = await readMarketActivity(client,{ ...query,market: fixtureKey(1).toBase58() });
  assert.notEqual(first.coverage.selectionHash,other.coverage.selectionHash);
  assert.equal(first.events,0); assert.equal(first.coverage.historyRangeComplete,false);
  await assert.rejects(readMarketActivity(client,{ ...query,since: '2026-09-03T00:00:00Z' }),/time range/);
  await assert.rejects(readMarketActivity(client,{ ...query,deploymentIdentitySha256: '' }),/time range/);
  await assert.rejects(readMarketActivity(client,{ ...query,market: 'invalid' }));
}));
