import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { PoolClient } from 'pg';
import pool from '../config/database';
import { loadPinnedProtocol } from '../config/duskProtocol';
import { projectYieldCheckpoint, projectYieldCheckpointBatch, readYieldCheckpoints, storeYieldCheckpointSource } from '../services/duskYieldCheckpoints';
import { checkpointFixture, fixtureKey } from './duskYieldCheckpointFixtures';

if (process.env.DUSK_ALLOW_DISPOSABLE_DB_TESTS !== 'true' || !process.env.DATABASE_URL)
  throw new Error('Set DUSK_ALLOW_DISPOSABLE_DB_TESTS=true and a disposable DATABASE_URL');
after(() => pool.end());
const pin = loadPinnedProtocol();
const active = [pin.cluster,pin.dusk.programId,pin.dusk.idlCanonicalSha256,pin.revision];

async function transaction(work: (client: PoolClient) => Promise<void>) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO dusk_ingestion.protocol_identities(cluster,program_id,idl_hash,protocol_revision)
      VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,active);
    await work(client);
  } finally { await client.query('ROLLBACK'); client.release(); }
}
async function rejectsAtSavepoint(client: PoolClient, operation: () => Promise<unknown>, error: RegExp) {
  await client.query('SAVEPOINT rejected_projection');
  await assert.rejects(operation(),error);
  await client.query('ROLLBACK TO SAVEPOINT rejected_projection');
}

test('coherent checkpoints replay once, retain exact amounts, and append older observations without replacing newer ones', () => transaction(async (client) => {
  const fixture = checkpointFixture(), source = fixture.source();
  const first = await storeYieldCheckpointSource(client,source);
  assert.equal(await storeYieldCheckpointSource(client,source),first);
  const projected = await projectYieldCheckpoint(client,first);
  assert.equal(projected.totalAmount,'21');
  await projectYieldCheckpoint(client,first);
  const older = await storeYieldCheckpointSource(client,{ ...source,slot: source.slot-1,blockTime: '2026-08-31T23:59:59Z' });
  await projectYieldCheckpoint(client,older);
  const view = await readYieldCheckpoints(client,{ owner: fixture.owner,limit: 1,offset: 0 });
  assert.equal(view.pagination.total,2);
  assert.equal(view.checkpoints[0].provenance.observationId,first);
  assert.equal(view.checkpoints[0].swapFeeAmount,'11');
  assert.equal(view.checkpoints[0].lpTokenAccount,fixture.lpTokenAccount);
  assert.equal(view.checkpoints[0].provenance.idlSha256,pin.dusk.idlCanonicalSha256);
  assert.equal(view.coverage.historyComplete,false);
  assert.equal(view.coverage.currentHarvestPreviewIncluded,false);
  assert.equal((await readYieldCheckpoints(client,{ owner: fixtureKey(123).toBase58(),limit: 10,offset: 0 })).pagination.total,0);
  await rejectsAtSavepoint(client,() => client.query('UPDATE dusk_ingestion.yield_checkpoint_observations SET blockhash=$1 WHERE observation_id=$2',[fixtureKey(124).toBase58(),first]),/FINALIZED_INVARIANT/);
  await rejectsAtSavepoint(client,() => client.query('DELETE FROM dusk_ingestion.yield_checkpoints WHERE observation_id=$1',[first]),/FINALIZED_INVARIANT/);
}));

test('missing canonical LP account contributes zero balance without erasing retained earnings', () => transaction(async (client) => {
  const fixture = checkpointFixture({ kind: 1,revenue: 'quote' });
  const source = fixture.source();
  source.accounts.lpToken = null;
  const id = await storeYieldCheckpointSource(client,source);
  const projected = await projectYieldCheckpoint(client,id);
  assert.equal(projected.lpBalance,'0');
  assert.equal(projected.totalAmount,'12');
  assert.equal(projected.assetDecimals,6);
  assert.equal((await client.query('SELECT raw_lp_account FROM dusk_ingestion.yield_checkpoints WHERE observation_id=$1',[id])).rows[0].raw_lp_account,null);
}));

test('bounded replay recovers saved observations and later older-slot backfill without a high-water cursor', () => transaction(async (client) => {
  const fixture = checkpointFixture(), source = fixture.source();
  const first = await storeYieldCheckpointSource(client,source);
  assert.equal(await projectYieldCheckpointBatch(client,1),1);
  assert.equal((await client.query('SELECT observation_id::text FROM dusk_ingestion.yield_checkpoints WHERE observation_id=$1',[first])).rows[0].observation_id,first);
  assert.equal(await projectYieldCheckpointBatch(client,1),0);
  const older = await storeYieldCheckpointSource(client,{ ...source,slot: source.slot-1 });
  assert.equal(await projectYieldCheckpointBatch(client,1),1);
  assert.equal((await client.query('SELECT observation_id::text FROM dusk_ingestion.yield_checkpoints WHERE observation_id=$1',[older])).rows[0].observation_id,older);
  assert.equal(await projectYieldCheckpointBatch(client,1),0);
}));

test('replay refuses contradictory saved observations and rollback leaves their evidence intact', () => transaction(async (client) => {
  const fixture = checkpointFixture(), source = fixture.source();
  const first = await storeYieldCheckpointSource(client,source);
  const conflicting = await storeYieldCheckpointSource(client,{ ...source,blockhash: fixtureKey(125).toBase58() });
  await rejectsAtSavepoint(client,() => projectYieldCheckpointBatch(client),/FINALIZED_INVARIANT/);
  assert.equal((await client.query('SELECT count(*)::int AS total FROM dusk_ingestion.yield_checkpoints WHERE observation_id=ANY($1::bigint[])',[[first,conflicting]])).rows[0].total,0);
  assert.equal((await client.query('SELECT count(*)::int AS total FROM dusk_ingestion.yield_checkpoint_observations WHERE observation_id=ANY($1::bigint[])',[[first,conflicting]])).rows[0].total,2);
}));

test('conflicting finalized evidence survives the rejected projection and makes history unavailable', () => transaction(async (client) => {
  const fixture = checkpointFixture(), source = fixture.source();
  const first = await storeYieldCheckpointSource(client,source);
  await projectYieldCheckpoint(client,first);
  const conflicting = await storeYieldCheckpointSource(client,{ ...source,blockhash: fixtureKey(125).toBase58() });
  await rejectsAtSavepoint(client,() => projectYieldCheckpoint(client,conflicting),/FINALIZED_INVARIANT/);
  assert.equal((await client.query('SELECT count(*)::int AS total FROM dusk_ingestion.yield_checkpoint_observations WHERE observation_id=ANY($1::bigint[])',[[first,conflicting]])).rows[0].total,2);
  assert.equal((await client.query('SELECT count(*)::int AS total FROM dusk_ingestion.yield_checkpoints WHERE observation_id=ANY($1::bigint[])',[[first,conflicting]])).rows[0].total,1);
  await assert.rejects(readYieldCheckpoints(client,{ owner: fixture.owner,limit: 10,offset: 0 }),/contradictory finalized/);
}));

test('invalid account ownership remains observable but cannot become a yield balance', () => transaction(async (client) => {
  const fixture = checkpointFixture(), source = fixture.source();
  source.accounts.lpToken!.owner = fixtureKey(126).toBase58();
  const id = await storeYieldCheckpointSource(client,source);
  await rejectsAtSavepoint(client,() => projectYieldCheckpoint(client,id),/wrong owner/);
  assert.equal((await client.query('SELECT count(*)::int AS total FROM dusk_ingestion.yield_checkpoint_observations WHERE observation_id=$1',[id])).rows[0].total,1);
  assert.equal((await client.query('SELECT count(*)::int AS total FROM dusk_ingestion.yield_checkpoints WHERE observation_id=$1',[id])).rows[0].total,0);
}));

test('checkpoint database guard refuses raw evidence copied from another snapshot', () => transaction(async (client) => {
  const fixture = checkpointFixture(), first = await storeYieldCheckpointSource(client,fixture.source());
  await projectYieldCheckpoint(client,first);
  const second = await storeYieldCheckpointSource(client,fixture.source(900000002,1n));
  await rejectsAtSavepoint(client,() => client.query(`INSERT INTO dusk_ingestion.yield_checkpoints
    (cluster,program_id,idl_hash,protocol_revision,yield_account,owner,market,lp_mint,asset_mint,token_kind,slot,blockhash,block_time,
     lp_balance,swap_fee_amount,interest_amount,swap_remainder_q64,interest_remainder_q64,raw_yield,raw_market,raw_lp_account,
     content_hash,observation_id,lp_token_account,asset_decimals,deployment_identity_sha256)
    SELECT p.cluster,p.program_id,p.idl_hash,p.protocol_revision,p.yield_account,p.owner,p.market,p.lp_mint,p.asset_mint,p.token_kind,
      o.slot,o.blockhash,o.block_time,p.lp_balance,p.swap_fee_amount,p.interest_amount,p.swap_remainder_q64,p.interest_remainder_q64,
      p.raw_yield,p.raw_market,p.raw_lp_account,o.content_hash,o.observation_id,p.lp_token_account,p.asset_decimals,o.deployment_identity_sha256
    FROM dusk_ingestion.yield_checkpoints p CROSS JOIN dusk_ingestion.yield_checkpoint_observations o
    WHERE p.observation_id=$1 AND o.observation_id=$2`,[first,second]),/FINALIZED_INVARIANT/);
}));
