import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { PoolClient } from 'pg';
import pool from '../config/database';
import { loadPinnedProtocol } from '../config/duskProtocol';
import { clearEventHistoryCache, eventHistoryState, readCachedEventHistory, readEventHistory } from '../services/duskEventHistory';
import { invalidateDuskReadCaches } from '../services/duskInvalidationService';
import { fixtureKey } from './duskYieldCheckpointFixtures';

if (process.env.DUSK_ALLOW_DISPOSABLE_DB_TESTS !== 'true' || !process.env.DATABASE_URL)
  throw new Error('Set DUSK_ALLOW_DISPOSABLE_DB_TESTS=true and a disposable DATABASE_URL');
after(() => pool.end());
const pin = loadPinnedProtocol(), identity = [pin.cluster,pin.dusk.programId,pin.dusk.idlCanonicalSha256,pin.revision];
const market = fixtureKey(159).toBase58(), slot = pin.historyFirstSlot + 100;
const query = { market, since: '2026-09-01T00:00:00Z', until: '2026-09-02T00:00:00Z', limit: 2, deploymentIdentitySha256: 'a'.repeat(64) };
let nextPath = 0;
async function transaction(work: (client: PoolClient) => Promise<void>) {
  const client = await pool.connect();
  clearEventHistoryCache();
  try { await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ'); await work(client); }
  finally { await client.query('ROLLBACK'); client.release(); }
}
async function source(client: PoolClient, offset: number, options: { commitment?: string; revision?: string; omitStream?: boolean; eventName?: string; owner?: string; liquidator?: string; borrower?: string; trader?: string } = {}) {
  const active = [...identity.slice(0,3),options.revision ?? identity[3]], commitment = options.commitment ?? 'finalized';
  const signature = '2'.repeat(88), path = [0, ++nextPath];
  const key = [...active, signature, path.join('.'), '0'].join('|');
  const eventName = options.eventName ?? 'SwapExecuted';
  const payload = { market, owner: options.owner, liquidator: options.liquidator, borrower: options.borrower, trader: options.trader ?? fixtureKey(121).toBase58(),asset_in_side:'0',amount_in:'9007199254740993',amount_out:'4' };
  await client.query(`INSERT INTO dusk_ingestion.protocol_identities(cluster,program_id,idl_hash,protocol_revision)
    VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,active);
  const inserted = await client.query(`INSERT INTO dusk_ingestion.event_observations
    (cluster,program_id,idl_hash,protocol_revision,event_key,transaction_signature,instruction_path,event_ordinal,
      slot,blockhash,commitment,event_name,payload_hash,decoded_payload,source)
    VALUES($1,$2,$3,$4,$5,$6,$12,0,$7,$8,$9,$13,$10,$11,'disposable-history-fixture') RETURNING observation_id`,
    [...active,key,signature,slot+offset,fixtureKey(130).toBase58(),commitment,createHash('sha256').update(JSON.stringify(payload)).digest('hex'),JSON.stringify(payload),path,eventName]);
  await client.query(`INSERT INTO dusk_ingestion.canonical_events
    (cluster,program_id,idl_hash,protocol_revision,event_key,observation_id,commitment) VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [...active,key,inserted.rows[0].observation_id,commitment]);
  if (!options.omitStream) await client.query(`INSERT INTO dusk_ingestion.event_stream
    (time,cluster,program_id,event_name,market,transaction_signature,event_key,slot,payload,idl_hash,protocol_revision)
    VALUES('2026-09-01T00:00:10Z',$1,$2,$10,$3,$4,$5,$6,$7,$8,$9)`,
    [active[0],active[1],market,signature,key,slot+offset,JSON.stringify(payload),active[2],active[3],eventName]);
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

test('v2 reads finalized hLP and yield events while v1 and position-close queries remain unchanged', () => transaction(async client => {
  const owner = fixtureKey(121).toBase58();
  await source(client,4,{eventName:'HlpOpened',owner});
  await source(client,3,{eventName:'HlpClosed',owner});
  await source(client,2,{eventName:'YieldClaimed',owner});
  await source(client,1,{eventName:'LiquidityAdded',owner});
  await source(client,5,{eventName:'HlpOpened',owner,commitment:'confirmed'});
  const v1 = await readEventHistory(client,{...query,limit:100});
  assert.deepEqual(v1.events.map(row=>row.eventName),['LiquidityAdded']);
  assert.equal(v1.schemaVersion,'dusk-event-history.v1');
  const first = await readEventHistory(client,{...query,version:2});
  assert.equal(first.schemaVersion,'dusk-event-history.v2');
  assert.deepEqual(first.events.map(row=>row.eventName),['HlpOpened','HlpClosed']);
  const next = await readEventHistory(client,{...query,version:2,cursor:first.pagination.nextCursor!});
  assert.deepEqual(next.events.map(row=>row.eventName),['YieldClaimed','LiquidityAdded']);
  assert.equal(next.coverage.historyRangeComplete,false);
  assert.equal((await readEventHistory(client,{...query,version:2,owner,category:'leverage-close'})).events.length,0);
}));
test('contradictory event-time records halt the selected page', () => transaction(async client => {
  const key = await source(client,0);
  await client.query(`INSERT INTO dusk_ingestion.event_stream
    (time,cluster,program_id,event_name,market,transaction_signature,event_key,slot,payload,idl_hash,protocol_revision)
    SELECT time+interval '1 second',cluster,program_id,event_name,market,transaction_signature,event_key,slot,payload,idl_hash,protocol_revision
    FROM dusk_ingestion.event_stream WHERE event_key=$1`,[key]);
  await assert.rejects(readEventHistory(client,query),/FINALIZED_INVARIANT/);
}));

test('closed positions filter the owner, not the liquidator, before pagination and bind cursors to that owner', () => transaction(async client => {
  const owner = fixtureKey(121).toBase58(), other = fixtureKey(122).toBase58();
  const scoped = { ...query, owner, category: 'leverage-close' as const, limit: 1 };
  await source(client,5,{ eventName:'LeveragePositionClosed',owner:other });
  await source(client,4,{ eventName:'LeveragePositionUpdated',owner });
  const liquidated = await source(client,3,{ eventName:'LeveragePositionLiquidated',owner,liquidator:other });
  const closed = await source(client,2,{ eventName:'LeveragePositionClosed',owner });
  await source(client,1,{ eventName:'LeveragePositionLiquidated',owner:other,liquidator:owner });
  const first = await readEventHistory(client,scoped);
  assert.equal(first.events[0].eventKey,liquidated);
  assert.equal(first.window.owner,owner);
  assert.equal(first.window.category,'leverage-close');
  assert.equal(first.pagination.hasMore,true);
  const last = await readEventHistory(client,{ ...scoped,cursor:first.pagination.nextCursor! });
  assert.deepEqual(last.events.map(event => event.eventKey),[closed]);
  assert.equal(last.pagination.hasMore,false);
  await assert.rejects(readEventHistory(client,{ ...scoped,owner:other,cursor:first.pagination.nextCursor! }),/query or cursor/);
  assert.equal((await readEventHistory(client,{ ...scoped,owner:fixtureKey(123).toBase58() })).events.length,0);
  assert.equal((await readEventHistory(client,{ ...scoped,market:fixtureKey(124).toBase58() })).events.length,0);
}));


test('wallet activity filters native participants before pagination and preserves distinct CPI receipts', () => transaction(async client => {
  const owner = fixtureKey(121).toBase58(), other = fixtureKey(122).toBase58();
  const scoped = {...query, version:2 as const, owner, category:'activity' as const, limit:2};
  await source(client,9,{eventName:'HlpOpened',owner:other});
  await source(client,8,{eventName:'SwapExecuted',trader:other,owner}); // unrelated payload owner is not a swap participant
  const swap = await source(client,7,{eventName:'SwapExecuted',trader:owner});
  const seized = await source(client,6,{eventName:'BorrowPositionLiquidated',borrower:owner,liquidator:other});
  const liquidated = await source(client,5,{eventName:'LeveragePositionLiquidated',owner:other,liquidator:owner});
  const deposit = await source(client,4,{eventName:'HlpOpened',owner});
  const claim = await source(client,3,{eventName:'YieldClaimed',owner});
  const first = await readEventHistory(client,scoped);
  assert.deepEqual(first.events.map(row=>row.eventKey),[swap,seized]);
  const second = await readEventHistory(client,{...scoped,cursor:first.pagination.nextCursor!});
  assert.deepEqual(second.events.map(row=>row.eventKey),[liquidated,deposit]);
  const last = await readEventHistory(client,{...scoped,cursor:second.pagination.nextCursor!});
  assert.deepEqual(last.events.map(row=>row.eventKey),[claim]);
  assert.equal(last.pagination.hasMore,false);
  for (const patch of [{owner:other},{category:'leverage-close' as const},{version:1 as const}])
    await assert.rejects(readEventHistory(client,{...scoped,...patch,cursor:first.pagination.nextCursor!}),/query or cursor/);
}));


test('a wallet holding both liquidation roles receives a single receipt', () => transaction(async client => {
  const owner = fixtureKey(121).toBase58();
  const borrowed = await source(client,2,{eventName:'BorrowPositionLiquidated',borrower:owner,liquidator:owner});
  const leveraged = await source(client,1,{eventName:'LeveragePositionLiquidated',owner,liquidator:owner});
  const data = await readEventHistory(client,{...query,version:2,category:'activity',owner,limit:10});
  assert.deepEqual(data.events.map(row=>row.eventKey),[borrowed,leveraged]);
}));

test('cache hits observe late replay and stream corruption without a notification listener', () => transaction(async client => {
  const key = await source(client,1);
  const first = await readCachedEventHistory(client,query);
  assert.equal(await readCachedEventHistory(client,query),first);
  await source(client,0);
  const replayed = await readCachedEventHistory(client,query);
  assert.notEqual(replayed,first);
  assert.equal(replayed.events.length,2);
  await client.query(`UPDATE dusk_ingestion.event_stream SET payload=payload||'{"invalid":true}'::jsonb WHERE event_key=$1`,[key]);
  await assert.rejects(readCachedEventHistory(client,query),/FINALIZED_INVARIANT/);
}));

test('a conflict outside the requested page invalidates a warm cache and remains a halt', () => transaction(async client => {
  await source(client,2);
  const old = await source(client,0);
  await readCachedEventHistory(client,{...query,limit:1});
  await client.query(`INSERT INTO dusk_ingestion.event_observations
    (cluster,program_id,idl_hash,protocol_revision,event_key,transaction_signature,instruction_path,event_ordinal,
     slot,blockhash,commitment,event_name,payload_hash,decoded_payload,source)
    SELECT cluster,program_id,idl_hash,protocol_revision,event_key,transaction_signature,instruction_path,event_ordinal,
     slot,'contradictory-finalized-bank',commitment,event_name,payload_hash,decoded_payload,source
    FROM dusk_ingestion.event_observations WHERE event_key=$1`,[old]);
  await assert.rejects(readCachedEventHistory(client,{...query,limit:1}),/FINALIZED_INVARIANT/);
  await client.query(`DELETE FROM dusk_ingestion.event_observations WHERE event_key=$1 AND blockhash='contradictory-finalized-bank'`,[old]);
  await assert.rejects(eventHistoryState(client,identity),/FINALIZED_INVARIANT/);
}));

test('simultaneous identical history reads share the page query but each checks the DB revision', () => transaction(async client => {
  await source(client,0);
  let pages=0,states=0;
  const tracked = new Proxy(client,{get(target,property) {
    if (property !== 'query') return Reflect.get(target,property);
    return async (text: string,params: unknown[]) => {
      if (text.includes('FROM dusk_ingestion.event_history_state')) states++;
      if (text.includes('history.stream_count')) {
        pages++;
        await new Promise(resolve=>setTimeout(resolve,30));
      }
      return target.query(text,params);
    };
  }});
  const results = await Promise.all(Array.from({length:12},()=>readCachedEventHistory(tracked,query)));
  assert.equal(pages,1); assert.equal(states,12);
  for (const result of results) assert.equal(result,results[0]);
}));

test('finalizing an existing observation advances the revision and discovers contradictions', () => transaction(async client => {
  const key = await source(client,0,{commitment:'confirmed'});
  const before = await eventHistoryState(client,identity);
  await client.query(`UPDATE dusk_ingestion.event_observations SET commitment='finalized' WHERE event_key=$1`,[key]);
  const after = await eventHistoryState(client,identity);
  assert.ok(BigInt(after.revision)>BigInt(before.revision));
  await client.query(`UPDATE dusk_ingestion.canonical_events SET commitment='finalized' WHERE event_key=$1`,[key]);
  assert.equal((await readEventHistory(client,query)).events.length,1);
}));

test('concurrent finalized writers serialize conflict detection before cached reads can accept it', async () => {
  const concurrentIdentity=[...identity.slice(0,3),'history-race-'+randomUUID()];
  const key=[...concurrentIdentity,'7'.repeat(88),'0','0'].join('|');
  const a=await pool.connect(),b=await pool.connect();
  let second:Promise<unknown>|undefined;
  const insert=`INSERT INTO dusk_ingestion.event_observations
    (cluster,program_id,idl_hash,protocol_revision,event_key,transaction_signature,instruction_path,event_ordinal,
     slot,blockhash,commitment,event_name,payload_hash,decoded_payload,source)
    VALUES($1,$2,$3,$4,$5,$6,ARRAY[0],0,$7,$8,'finalized','SwapExecuted',$9,'{}','history-conflict-race')`;
  const values=[...concurrentIdentity,key,'7'.repeat(88),slot];
  try {
    await pool.query(`INSERT INTO dusk_ingestion.protocol_identities(cluster,program_id,idl_hash,protocol_revision)
      VALUES($1,$2,$3,$4)`,concurrentIdentity);
    await a.query('BEGIN');await b.query('BEGIN');
    const pid=(await b.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await a.query(insert,[...values,'history-race-a','a'.repeat(64)]);
    second=b.query(insert,[...values,'history-race-b','b'.repeat(64)]);
    // A real DB lock, rather than a timer-based assumption about scheduling.
    let blocked=false;
    for(let i=0;i<100;i++) {
      blocked=(await pool.query('SELECT cardinality(pg_blocking_pids($1))>0 AS blocked',[pid])).rows[0].blocked;
      if(blocked) break;
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert.equal(blocked,true);
    await a.query('COMMIT');await second;
    await assert.rejects(eventHistoryState(b,concurrentIdentity),/FINALIZED_INVARIANT/);
    await b.query('ROLLBACK');
    assert.equal((await eventHistoryState(a,concurrentIdentity)).conflicted,false,'Rolled-back writes do not poison committed state');
  } finally {
    await a.query('ROLLBACK');
    await second?.catch(()=>undefined);
    await b.query('ROLLBACK');
    await pool.query(`DELETE FROM dusk_ingestion.event_observations WHERE protocol_revision=$1`,[concurrentIdentity[3]]);
    await pool.query(`DELETE FROM dusk_ingestion.event_history_finalized_witnesses WHERE protocol_revision=$1`,[concurrentIdentity[3]]);
    await pool.query(`DELETE FROM dusk_ingestion.event_history_state WHERE protocol_revision=$1`,[concurrentIdentity[3]]);
    await pool.query(`DELETE FROM dusk_ingestion.protocol_identities WHERE protocol_revision=$1`,[concurrentIdentity[3]]);
    a.release();b.release();
  }
});

test('role limits are applied after time and canonical filters, so excluded recent rows cannot hide a wallet page', () => transaction(async client => {
  const owner=fixtureKey(121).toBase58(),other=fixtureKey(122).toBase58();
  const expected=[await source(client,2,{eventName:'HlpOpened',owner}),
    await source(client,1,{eventName:'LeveragePositionLiquidated',owner:other,liquidator:owner})];
  for(let i=3;i<9;i++) {
    const key=await source(client,i,{eventName:'LeveragePositionLiquidated',owner,liquidator:other});
    await client.query(`UPDATE dusk_ingestion.event_stream SET time='2026-09-03T00:00:00Z' WHERE event_key=$1`,[key]);
    const uncanonical=await source(client,i+10,{eventName:'HlpOpened',owner,commitment:'confirmed'});
    await client.query(`UPDATE dusk_ingestion.event_observations SET commitment='finalized' WHERE event_key=$1`,[uncanonical]);
  }
  const data=await readEventHistory(client,{...query,version:2,owner,category:'activity'});
  assert.deepEqual(data.events.map(row=>row.eventKey),expected);
  assert.equal(data.pagination.hasMore,false);
}));


test('matching native notifications invalidate a cached page immediately', () => transaction(async client => {
  await source(client,0);
  const first=await readCachedEventHistory(client,query);
  const notice={cluster:pin.cluster,programId:pin.dusk.programId,idlHash:pin.dusk.idlCanonicalSha256,
    protocolRevision:pin.revision,slot};
  invalidateDuskReadCaches(JSON.stringify({...notice,protocolRevision:'other-release'}));
  assert.equal(await readCachedEventHistory(client,query),first);
  invalidateDuskReadCaches(JSON.stringify(notice));
  assert.notEqual(await readCachedEventHistory(client,query),first);
}));
