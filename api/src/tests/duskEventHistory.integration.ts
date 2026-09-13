import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { PoolClient } from 'pg';
import pool from '../config/database';
import { loadPinnedProtocol } from '../config/duskProtocol';
import { readEventHistory } from '../services/duskEventHistory';
import { fixtureKey } from './duskYieldCheckpointFixtures';

if (process.env.DUSK_ALLOW_DISPOSABLE_DB_TESTS !== 'true' || !process.env.DATABASE_URL)
  throw new Error('Set DUSK_ALLOW_DISPOSABLE_DB_TESTS=true and a disposable DATABASE_URL');
after(() => pool.end());
const pin = loadPinnedProtocol(), identity = [pin.cluster,pin.dusk.programId,pin.dusk.idlCanonicalSha256,pin.revision];
const market = fixtureKey(159).toBase58(), slot = pin.historyFirstSlot + 100;
const query = { market, since: '2026-09-01T00:00:00Z', until: '2026-09-02T00:00:00Z', limit: 2, deploymentIdentitySha256: 'a'.repeat(64) };
async function transaction(work: (client: PoolClient) => Promise<void>) {
  const client = await pool.connect();
  try { await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ'); await work(client); }
  finally { await client.query('ROLLBACK'); client.release(); }
}
async function source(client: PoolClient, offset: number, options: { commitment?: string; revision?: string; omitStream?: boolean } = {}) {
  const active = [...identity.slice(0,3),options.revision ?? identity[3]], commitment = options.commitment ?? 'finalized';
  const key = createHash('sha256').update(randomUUID()).digest('hex'), signature = '2'.repeat(88);
  const payload = { market,trader: fixtureKey(121).toBase58(),asset_in_side:'0',amount_in:'9007199254740993',amount_out:'4' };
  await client.query(`INSERT INTO dusk_ingestion.protocol_identities(cluster,program_id,idl_hash,protocol_revision)
    VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,active);
  const inserted = await client.query(`INSERT INTO dusk_ingestion.event_observations
    (cluster,program_id,idl_hash,protocol_revision,event_key,transaction_signature,instruction_path,event_ordinal,
      slot,blockhash,commitment,event_name,payload_hash,decoded_payload,source)
    VALUES($1,$2,$3,$4,$5,$6,'{0,1}',0,$7,$8,$9,'SwapExecuted',$10,$11,'disposable-history-fixture') RETURNING observation_id`,
    [...active,key,signature,slot+offset,fixtureKey(130).toBase58(),commitment,createHash('sha256').update(JSON.stringify(payload)).digest('hex'),JSON.stringify(payload)]);
  await client.query(`INSERT INTO dusk_ingestion.canonical_events
    (cluster,program_id,idl_hash,protocol_revision,event_key,observation_id,commitment) VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [...active,key,inserted.rows[0].observation_id,commitment]);
  if (!options.omitStream) await client.query(`INSERT INTO dusk_ingestion.event_stream
    (time,cluster,program_id,event_name,market,transaction_signature,event_key,slot,payload,idl_hash,protocol_revision)
    VALUES('2026-09-01T00:00:10Z',$1,$2,'SwapExecuted',$3,$4,$5,$6,$7,$8,$9)`,
    [active[0],active[1],market,signature,key,slot+offset,JSON.stringify(payload),active[2],active[3]]);
  return key;
}
test('native history paginates same-slot CPI events without signature deduplication or late-backfill shifts', () => transaction(async client => {
  await source(client,2); await source(client,2); await source(client,1);
  await source(client,3,{ commitment:'confirmed' });
  await source(client,4,{ revision:'fixture-'+randomUUID() });
  const first = await readEventHistory(client,query);
  assert.equal(first.events.length,2); assert.equal(first.pagination.hasMore,true);
  assert.notEqual(first.events[0].eventKey,first.events[1].eventKey);
  assert.equal(first.events[0].signature,first.events[1].signature);
  assert.equal(first.events[0].payload.amount_in,'9007199254740993');
  await source(client,0);
  const second = await readEventHistory(client,{ ...query,cursor:first.pagination.nextCursor! });
  assert.equal(second.events.length,1); assert.equal(second.pagination.hasMore,false);
  assert.equal(second.pagination.watermark,first.pagination.watermark);
  assert.equal(second.coverage.historyRangeComplete,false);
  assert.equal((await readEventHistory(client,{ ...query,limit:100 })).events.length,4);
  await assert.rejects(readEventHistory(client,{ ...query,market:fixtureKey(1).toBase58(),cursor:first.pagination.nextCursor! }),/query or cursor/);
  await assert.rejects(readEventHistory(client,{ ...query,deploymentIdentitySha256:'b'.repeat(64),cursor:first.pagination.nextCursor! }),/query or cursor/);
}));
test('a missing event-time record and conflicting stream timestamps fail instead of appearing empty', () => transaction(async client => {
  await source(client,0,{ omitStream:true });
  await assert.rejects(readEventHistory(client,query),/FINALIZED_INVARIANT/);
}));
test('contradictory event-time records halt the selected page', () => transaction(async client => {
  const key = await source(client,0);
  await client.query(`INSERT INTO dusk_ingestion.event_stream
    (time,cluster,program_id,event_name,market,transaction_signature,event_key,slot,payload,idl_hash,protocol_revision)
    SELECT time+interval '1 second',cluster,program_id,event_name,market,transaction_signature,event_key,slot,payload,idl_hash,protocol_revision
    FROM dusk_ingestion.event_stream WHERE event_key=$1`,[key]);
  await assert.rejects(readEventHistory(client,query),/FINALIZED_INVARIANT/);
}));
