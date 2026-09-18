/** Native history benchmark. HTTP mode is read-only; DB mode requires an
 * explicitly disposable database, seeds synthetic events and always rolls back.
 * Baseline input is an optional reviewed TypeScript service saved from git. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { randomInt } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import type { PoolClient } from 'pg';
import pool from '../config/database';
import { loadPinnedProtocol } from '../config/duskProtocol';
import { buildEventHistoryQuery, clearEventHistoryCache, eventHistoryState, EventHistoryQuery,
  readCachedEventHistory, readEventHistory } from '../services/duskEventHistory';

const iterations = Number(process.env.BENCH_ITERATIONS ?? '20');
const concurrency = Number(process.env.BENCH_CONCURRENCY ?? '12');
if (!Number.isInteger(iterations) || iterations<1 || iterations>100
  || !Number.isInteger(concurrency) || concurrency<1 || concurrency>50) throw new Error('Invalid benchmark bounds');
function summary(samples: number[]) {
  const sorted=[...samples].sort((a,b)=>a-b), at=(q:number)=>Number(sorted[Math.floor((sorted.length-1)*q)].toFixed(2));
  return {requests:samples.length,p50Ms:at(.5),p95Ms:at(.95),maxMs:at(1)};
}
async function measure(load:()=>Promise<unknown>) {
  const samples:number[]=[];
  for(let i=0;i<iterations;i++) {const start=performance.now();await load();samples.push(performance.now()-start);}
  return summary(samples);
}
function fixtureKey(seed:number) {return new PublicKey(Uint8Array.from({length:32},()=>seed)).toBase58();}

async function databaseBenchmark() {
  if(process.env.DUSK_ALLOW_DISPOSABLE_DB_TESTS!=='true' || !process.env.DATABASE_URL)
    throw new Error('DB benchmark requires DUSK_ALLOW_DISPOSABLE_DB_TESTS=true and a disposable DATABASE_URL');
  const count=Number(process.env.BENCH_EVENTS ?? '50000');
  if(!Number.isInteger(count)||count<1000||count>60000) throw new Error('BENCH_EVENTS must be 1000..60000');
  const client=await pool.connect(), pin=loadPinnedProtocol();
  const identity=[pin.cluster,pin.dusk.programId,pin.dusk.idlCanonicalSha256,pin.revision];
  const market=fixtureKey(141),otherMarket=fixtureKey(142),owner=fixtureKey(143),other=fixtureKey(144);
  const signature='5'.repeat(88),prefix=[...identity,signature,`${randomInt(1,65000)}.${randomInt(1,65000)}`].join('|');
  const query:EventHistoryQuery={version:2,owner,category:'activity',until:'2026-09-02T00:00:00Z',limit:50,deploymentIdentitySha256:'a'.repeat(64)};
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    const seedStarted=performance.now();
    await client.query(`INSERT INTO dusk_ingestion.protocol_identities(cluster,program_id,idl_hash,protocol_revision)
      VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,identity);
    await client.query(`INSERT INTO dusk_ingestion.event_observations
      (cluster,program_id,idl_hash,protocol_revision,event_key,transaction_signature,instruction_path,event_ordinal,
       slot,blockhash,commitment,event_name,payload_hash,decoded_payload,source)
      SELECT $1,$2,$3,$4,$5||'.'||g||'|0',$6,string_to_array(split_part($5,'|',6),'.')::int[]||ARRAY[g],0,$7::bigint+g,'benchmark-bank','finalized',
        CASE g%4 WHEN 0 THEN 'SwapExecuted' WHEN 1 THEN 'HlpOpened' WHEN 2 THEN 'YieldClaimed' ELSE 'LeveragePositionLiquidated' END,
        repeat('a',64),jsonb_build_object('market',CASE WHEN g%3=0 THEN $9::text ELSE $8::text END,
          'owner',CASE WHEN g%997=0 THEN $10::text ELSE $11::text END,
          'trader',CASE WHEN g%997=0 THEN $10::text ELSE $11::text END,
          'liquidator',CASE WHEN g%991=0 THEN $10::text ELSE $11::text END,'amount','9007199254740993'),
        'rollback-only-history-benchmark' FROM generate_series(1,$12::int) g`,
      [...identity,prefix,signature,pin.historyFirstSlot,market,otherMarket,owner,other,count]);
    await client.query(`INSERT INTO dusk_ingestion.canonical_events
      (cluster,program_id,idl_hash,protocol_revision,event_key,observation_id,commitment)
      SELECT cluster,program_id,idl_hash,protocol_revision,event_key,observation_id,commitment
      FROM dusk_ingestion.event_observations WHERE event_key LIKE $1`,[prefix+'.%']);
    await client.query(`INSERT INTO dusk_ingestion.event_stream
      (time,cluster,program_id,event_name,market,transaction_signature,event_key,slot,payload,idl_hash,protocol_revision)
      SELECT '2026-09-01T00:00:10Z',cluster,program_id,event_name,decoded_payload->>'market',transaction_signature,
        event_key,slot,decoded_payload,idl_hash,protocol_revision FROM dusk_ingestion.event_observations WHERE event_key LIKE $1`,[prefix+'.%']);
    const seedMs=performance.now()-seedStarted;
    await client.query('ANALYZE dusk_ingestion.event_observations');
    await client.query('ANALYZE dusk_ingestion.canonical_events');
    await client.query('ANALYZE dusk_ingestion.event_stream');
    const result=await readEventHistory(client,query);
    const report:Record<string,unknown>={mode:'rollback-only DB service benchmark (excludes HTTP/RPC)',events:count,
      returned:result.events.length,seedMs:Number(seedMs.toFixed(2)),iterations,concurrency};
    if(process.env.BENCH_BASELINE_TS) {
      const ts=await import('typescript');
      const compiled=ts.transpileModule(readFileSync(process.env.BENCH_BASELINE_TS,'utf8'),
        {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,esModuleInterop:true}});
      const baseline:{exports:{readEventHistory?:typeof readEventHistory}}={exports:{}};
      new Function('require','module','exports',compiled.outputText)(
        createRequire(resolve(__dirname,'../services/duskEventHistory.js')),baseline,baseline.exports);
      const read=baseline.exports.readEventHistory!;
      assert.deepEqual(await read(client,query),result,'Optimized page must equal the reviewed baseline');
      report.baseline=await measure(()=>read(client,query));
    }
    report.uncached=await measure(()=>readEventHistory(client,query));
    clearEventHistoryCache();
    await readCachedEventHistory(client,query);
    report.cached=await measure(()=>readCachedEventHistory(client,query));
    clearEventHistoryCache();
    let pageQueries=0,stateQueries=0;
    const tracked=new Proxy(client,{get(target,property) {
      if(property!=='query') return Reflect.get(target,property);
      return (text:string,params:unknown[])=>{
        if(text.includes('history.stream_count')) pageQueries++;
        if(text.includes('FROM dusk_ingestion.event_history_state')) stateQueries++;
        return target.query(text,params);
      };
    }});
    const began=performance.now();
    await Promise.all(Array.from({length:concurrency},()=>readCachedEventHistory(tracked,query)));
    report.concurrentCold={durationMs:Number((performance.now()-began).toFixed(2)),pageQueries,stateQueries};
    assert.equal(pageQueries,1,'Identical concurrent requests must share the page query');
    assert.equal(stateQueries,concurrency,'Every request must check committed state');
    const state=await eventHistoryState(client,identity);
    const explain=async(q:EventHistoryQuery)=>{
      const sql=buildEventHistoryQuery(q,state.watermark);
      return (await client.query('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+sql.text,sql.params)).rows[0]['QUERY PLAN'][0];
    };
    report.walletPlan=await explain(query);
    report.denseWalletPlan=await explain({...query,owner:other});
    const outerPlans=(report.denseWalletPlan as {Plan:unknown}).Plan;
    const lateralLoops=(node:any):number => (node['Node Type']==='Aggregate' ? node['Actual Loops'] : 0)
      +(node.Plans??[]).reduce((total:number,child:any)=>total+lateralLoops(child),0);
    assert.ok(lateralLoops(outerPlans)<=2*(query.limit+1),'Dense wallet must not inspect stream evidence for its entire history');
    report.denseWallet=await measure(()=>readEventHistory(client,{...query,owner:other}));
    if(result.pagination.nextCursor) report.cursorPlan=await explain({...query,cursor:result.pagination.nextCursor});
    report.marketPlan=await explain({...query,owner:undefined,category:undefined,market});
    report.walletMarketPlan=await explain({...query,market});
    const planText=JSON.stringify(report.walletPlan);
    assert.match(planText,/dusk_history_actor_page/,'Sparse wallet must use the actor index');
    assert.match(planText,/dusk_history_liquidator_page/,'Liquidator lookup must use its index');
    return report;
  } finally {
    clearEventHistoryCache();
    await client.query('ROLLBACK');
    client.release();
  }
}

async function httpBenchmark() {
  const base=process.env.API_BASE_URL,owner=process.env.DUSK_HISTORY_OWNER;
  if(!base||!owner) throw new Error('Set API_BASE_URL and DUSK_HISTORY_OWNER for the read-only native HTTP benchmark');
  new PublicKey(owner);
  const url=new URL('/api/dusk/v1/history/events',base);
  url.search=new URLSearchParams({version:'2',owner,category:'activity',limit:'50',until:new Date().toISOString()}).toString();
  if(process.env.DUSK_HISTORY_MARKET) url.searchParams.set('market',process.env.DUSK_HISTORY_MARKET);
  const load=async()=>{
    const response=await fetch(url,{signal:AbortSignal.timeout(30_000)});
    if(!response.ok) throw new Error(`Native history returned HTTP ${response.status}`);
    const body=await response.json() as {success?:boolean;data?:{schemaVersion?:string};deployment?:{schemaVersion?:string}};
    assert.equal(body.success,true);
    assert.equal(body.data?.schemaVersion,'dusk-event-history.v2');
    assert.equal(body.deployment?.schemaVersion,'dusk-deployment.v2');
  };
  const sequential=await measure(load);
  const start=performance.now();await Promise.all(Array.from({length:concurrency},load));
  return {mode:'native HTTP including deployment checks',sequential,concurrency,concurrentMs:Number((performance.now()-start).toFixed(2))};
}
async function main() {
  const report=process.env.BENCH_MODE==='database' ? await databaseBenchmark() : await httpBenchmark();
  const output=JSON.stringify(report,null,2)+'\n';
  if(process.env.BENCH_OUTPUT) writeFileSync(process.env.BENCH_OUTPUT,output);
  console.log(output);
}
main().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>pool.end());
