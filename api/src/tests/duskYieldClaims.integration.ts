/** Local, disposable PostgreSQL only; every fixture/projection is rolled back. */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { PoolClient } from 'pg';
import pool from '../config/database';
import { loadPinnedProtocol } from '../config/duskProtocol';
import { projectYieldClaimBatch, readYieldClaims } from '../services/duskYieldClaims';

if (process.env.DUSK_ALLOW_DISPOSABLE_DB_TESTS !== 'true' || !process.env.DATABASE_URL)
  throw new Error('Set DUSK_ALLOW_DISPOSABLE_DB_TESTS=true and a disposable DATABASE_URL');
after(() => pool.end());
const pin = loadPinnedProtocol();
const active = [pin.cluster,pin.dusk.programId,pin.dusk.idlCanonicalSha256,pin.revision];
const key = (value: number) => new PublicKey(Buffer.alloc(32,value)).toBase58();
const owner = key(81), market = key(82), recipient = key(83), caller = key(84);
const payload = (slot: number) => ({ owner,market,lp_mint: key(85),asset_mint: key(86),recipient,
  token_kind: '0',swap_fee_amount: '9007199254740993',interest_amount: '7',recipient_credit: '9007199254740990',
  metadata: { market,slot: String(slot),signer: caller } });

async function source(client: PoolClient, options: {
  slot: number; commitment?: string; revision?: string; fields?: object; time?: Date; omitStream?: boolean;
}) {
  const id = [active[0],active[1],active[2],options.revision ?? active[3]];
  const eventKey = createHash('sha256').update(randomUUID()).digest('hex');
  const fields = options.fields ?? payload(options.slot);
  const commitment = options.commitment ?? 'finalized';
  const hash = createHash('sha256').update(JSON.stringify(fields)).digest('hex');
  await client.query(`INSERT INTO dusk_ingestion.protocol_identities(cluster,program_id,idl_hash,protocol_revision)
    VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`, id);
  const inserted = await client.query(`INSERT INTO dusk_ingestion.event_observations
    (cluster,program_id,idl_hash,protocol_revision,event_key,transaction_signature,instruction_path,event_ordinal,
     slot,blockhash,commitment,event_name,payload_hash,decoded_payload,source)
    VALUES($1,$2,$3,$4,$5,$6,'{0,1}',0,$7,$8,$9,'YieldClaimed',$10,$11,'disposable-integration-fixture') RETURNING observation_id`,
    [...id,eventKey,`fixture-${eventKey}`,options.slot,key(87),commitment,hash,JSON.stringify(fields)]);
  await client.query(`INSERT INTO dusk_ingestion.canonical_events
    (cluster,program_id,idl_hash,protocol_revision,event_key,observation_id,commitment) VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [...id,eventKey,inserted.rows[0].observation_id,commitment]);
  if (!options.omitStream) await client.query(`INSERT INTO dusk_ingestion.event_stream
    (time,cluster,program_id,event_name,market,transaction_signature,event_key,slot,payload,idl_hash,protocol_revision)
    VALUES($1,$2,$3,'YieldClaimed',$4,$5,$6,$7,$8,$9,$10)`,
    [options.time ?? new Date('2026-09-01T00:00:00Z'),id[0],id[1],market,`fixture-${eventKey}`,eventKey,options.slot,JSON.stringify(fields),id[2],id[3]]);
  return eventKey;
}

async function transaction(work: (client: PoolClient) => Promise<void>) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Drain pre-existing finalized test data within this rollback-only transaction.
    while (await projectYieldClaimBatch(client) === 500) { /* bounded batches */ }
    await work(client);
  } finally { await client.query('ROLLBACK'); client.release(); }
}

async function rejectsAtSavepoint(client: PoolClient, operation: () => Promise<unknown>, message: RegExp) {
  await client.query('SAVEPOINT expected_failure');
  await assert.rejects(operation(), message);
  await client.query('ROLLBACK TO SAVEPOINT expected_failure');
}

test('finalized cash flows replay once, discover late old slots, and preserve event time and earning owner', () => transaction(async (client) => {
  const first = await source(client, { slot: 800000001 });
  await source(client, { slot: 800000003, commitment: 'processed' });
  await source(client, { slot: 800000004, revision: `fixture-other-${randomUUID()}` });
  assert.equal(await projectYieldClaimBatch(client), 1);
  assert.equal(await projectYieldClaimBatch(client), 0);
  const older = await source(client, { slot: 799999990, time: new Date('2026-08-31T23:59:00Z') });
  assert.equal(await projectYieldClaimBatch(client), 1);
  const view = await readYieldClaims(client, { owner,limit: 1,offset: 0 });
  assert.equal(view.pagination.total, 2);
  assert.equal(view.claims[0].eventKey, first);
  assert.equal(view.claims[0].grossAmount, '9007199254741000');
  assert.equal(view.claims[0].recipientCredit, '9007199254740990');
  assert.equal(view.claims[0].caller, caller);
  assert.equal(view.claims[0].recipient, recipient);
  assert.equal(view.claims[0].blockTime, '2026-09-01T00:00:00.000Z');
  assert.equal(view.coverage.projectionComplete, true);
  assert.equal(view.coverage.ingestionRangeComplete, false);
  assert.equal(view.coverage.accrualHistoryAvailable, false);
  const next = await readYieldClaims(client, { owner,limit: 1,offset: 1 });
  assert.equal(next.claims[0].eventKey, older);
  assert.equal((await readYieldClaims(client, { owner: recipient,limit: 10,offset: 0 })).pagination.total, 0);
  const filtered = await readYieldClaims(client, { owner,limit: 10,offset: 0,since: '2026-09-01T00:00:00Z' });
  assert.equal(filtered.pagination.total, 1);
  await rejectsAtSavepoint(client, () => client.query('UPDATE dusk_ingestion.yield_claims SET owner=$1 WHERE event_key=$2', [recipient,first]), /FINALIZED_INVARIANT/);
  await rejectsAtSavepoint(client, () => client.query('DELETE FROM dusk_ingestion.yield_claims WHERE event_key=$1', [first]), /FINALIZED_INVARIANT/);
}));

test('missing event-time evidence halts projection and reports a backlog', () => transaction(async (client) => {
  await source(client, { slot: 800000006, omitStream: true });
  const before = await readYieldClaims(client, { owner,limit: 10,offset: 0 });
  assert.equal(before.coverage.pendingClaims, '1');
  assert.equal(before.coverage.projectionComplete, false);
  await rejectsAtSavepoint(client, () => projectYieldClaimBatch(client), /FINALIZED_INVARIANT/);
  assert.equal((await readYieldClaims(client, { owner,limit: 10,offset: 0 })).pagination.total, 0);
}));

test('a malformed source rolls back its entire projection batch', () => transaction(async (client) => {
  await source(client, { slot: 800000010 });
  await source(client, { slot: 800000011,fields: { ...payload(800000011),recipient_credit: '18446744073709551615' } });
  await rejectsAtSavepoint(client, () => projectYieldClaimBatch(client), /inconsistent/);
  assert.equal((await readYieldClaims(client, { owner,limit: 10,offset: 0 })).pagination.total, 0);
}));

test('contradictory timestamps for one canonical event are not counted as two claims', () => transaction(async (client) => {
  const eventKey = await source(client, { slot: 800000009 });
  await client.query(`INSERT INTO dusk_ingestion.event_stream
    (time,cluster,program_id,event_name,market,transaction_signature,event_key,slot,payload,idl_hash,protocol_revision)
    SELECT time+interval '1 second',cluster,program_id,event_name,market,transaction_signature,event_key,slot,payload,idl_hash,protocol_revision
    FROM dusk_ingestion.event_stream WHERE event_key=$1`, [eventKey]);
  await rejectsAtSavepoint(client, () => projectYieldClaimBatch(client), /FINALIZED_INVARIANT/);
  assert.equal((await readYieldClaims(client, { owner,limit: 10,offset: 0 })).pagination.total, 0);
}));

test('database guard rejects a projection that substitutes the recipient as owner', () => transaction(async (client) => {
  const eventKey = await source(client, { slot: 800000012 });
  await rejectsAtSavepoint(client, () => client.query(`INSERT INTO dusk_ingestion.yield_claims
    (cluster,program_id,idl_hash,protocol_revision,event_key,observation_id,signature,slot,blockhash,block_time,
     owner,market,lp_mint,asset_mint,recipient,token_kind,swap_fee_amount,interest_amount,recipient_credit,payload)
    SELECT c.cluster,c.program_id,c.idl_hash,c.protocol_revision,c.event_key,c.observation_id,o.transaction_signature,
      o.slot,o.blockhash,s.time,$2,$3,$4,$5,$2,0,9007199254740993,7,9007199254740990,o.decoded_payload
    FROM dusk_ingestion.canonical_events c
    JOIN dusk_ingestion.event_observations o USING(cluster,program_id,idl_hash,protocol_revision,event_key,observation_id)
    JOIN dusk_ingestion.event_stream s USING(cluster,program_id,idl_hash,protocol_revision,event_key)
    WHERE c.event_key=$1`, [eventKey,recipient,market,key(85),key(86)]), /FINALIZED_INVARIANT/);
}));

test('historical prices reject non-finite values and future-dated source observations', () => transaction(async (client) => {
  for (const price of ['NaN','Infinity','-Infinity','0','-1'])
    await rejectsAtSavepoint(client, () => client.query(`INSERT INTO dusk_ingestion.price_observations
      (cluster,program_id,idl_hash,protocol_revision,mint,decimals,observed_at,source_time,price_usd,quality,source,source_evidence)
      VALUES($1,$2,$3,$4,$5,6,now(),now(),$6,'configured-reference','fixture','{}')`, [...active,key(86),price]), /check constraint/);
  await rejectsAtSavepoint(client, () => client.query(`INSERT INTO dusk_ingestion.price_observations
    (cluster,program_id,idl_hash,protocol_revision,mint,decimals,observed_at,source_time,price_usd,quality,source,source_evidence)
    VALUES($1,$2,$3,$4,$5,6,now(),now()+interval '1 day',1,'configured-reference','fixture','{}')`, [...active,key(86)]), /check constraint/);
}));
