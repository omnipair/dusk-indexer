/** Local disposable PostgreSQL; all test rows roll back. */
import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {PoolClient} from 'pg';
import pool from '../config/database';
import {loadPinnedProtocol} from '../config/duskProtocol';
import {readOrderHistory} from '../services/duskOrderHistory';
if(process.env.DUSK_ALLOW_DISPOSABLE_DB_TESTS!=='true'||!process.env.DATABASE_URL) throw new Error('Disposable database required');
after(()=>pool.end());
const pin=loadPinnedProtocol(),first=pin.historyFirstSlot,identity=[pin.cluster,pin.leverageDelegate.programId,pin.leverageDelegate.idlCanonicalSha256,pin.revision];
const owner='11111111111111111111111111111111',order=pin.leverageDelegate.programId,market=pin.dusk.programId,block='3'.repeat(44),signature='2'.repeat(88),when=1788307200;
const instructionKey=(path:number[],sig=signature)=>[...identity,sig,path.join('.')].join('|');
async function setup(c:PoolClient) {
  const body=JSON.stringify({revision:pin.revision,cluster:{name:pin.cluster,genesisHash:pin.genesisHash},programs:[pin.dusk,pin.leverageDelegate].map(p=>({name:p.name,programId:p.programId,binary:{sha256:p.binarySha256},idl:{canonicalSha256:p.idlCanonicalSha256},deployment:p.deployment}))});
  await c.query('SELECT dusk_ingestion.record_deployment_interval($1,$2,$3,$4,$5,$6)',[pin.cluster,pin.revision,first,first+100,createHash('sha256').update(body).digest('hex'),body]);
  await c.query('INSERT INTO dusk_ingestion.protocol_identities VALUES($1,$2,$3,$4,now()) ON CONFLICT DO NOTHING',identity);
}
async function observe(c:PoolClient,path:number[],name='cancel_leverage_order',sig=signature,slot=first+1) {
  const named={owner,order,...(name.startsWith('create_')?{market}:{})};
  return (await c.query('SELECT dusk_ingestion.record_order_instruction($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) AS ok',
    [...identity,instructionKey(path,sig),sig,slot,block,when,path,name,order,owner,name.startsWith('create_')?market:null,Buffer.from([1,2,3]),JSON.stringify({accounts:{named,all:Object.values(named)},arguments:{}})])).rows[0].ok;
}
async function scan(c:PoolClient,receipts:unknown[]) {
  return c.query(`INSERT INTO dusk_ingestion.order_history_scans(cluster,program_id,idl_hash,protocol_revision,from_slot,through_slot,boundary_signature,boundary_slot,through_blockhash,release_block_time,through_block_time,transactions)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,to_timestamp($10),to_timestamp($11),$12)`,[...identity,first,first+10,signature,first-1,block,when-100,when+100,JSON.stringify(receipts)]);
}
const receipt=(paths:number[][],sig=signature,failed=false)=>({signature:sig,slot:first+1,blockhash:block,failed,transactionSha256:'a'.repeat(64),instructionKeys:paths.map(p=>instructionKey(p,sig)).sort()});
const query={owner,until:new Date().toISOString(),limit:1,deploymentIdentitySha256:'a'.repeat(64)};
async function transaction(work:(c:PoolClient)=>Promise<void>){const c=await pool.connect();try{await c.query('BEGIN');await setup(c);await work(c);}finally{await c.query('ROLLBACK');c.release();}}
async function reject(c:PoolClient,work:()=>Promise<unknown>){await c.query('SAVEPOINT rejection');await assert.rejects(work,/FINALIZED_INVARIANT/);await c.query('ROLLBACK TO SAVEPOINT rejection');}

test('same transaction create/cancel history survives account closure and paginates with a stable watermark',()=>transaction(async c=>{
  assert.equal(await observe(c,[0],'create_leverage_order'),true);
  assert.equal(await observe(c,[1]),true);
  assert.equal(await observe(c,[1]),true);
  assert.equal(await observe(c,[0],'create_leverage_order','4'.repeat(88)),true);
  assert.equal(await observe(c,[1],'cancel_leverage_order','4'.repeat(88)),true);
  await reject(c,()=>scan(c,[]));
  await scan(c,[receipt([[0],[1]]),receipt([[0],[1]],'4'.repeat(88))]);
  const page=await readOrderHistory(c,query);assert.equal(page.orders.length,1);assert.equal(page.orders[0].market,market);assert.equal(page.pagination.hasMore,true);
  const next=await readOrderHistory(c,{...query,cursor:page.pagination.nextCursor!});assert.equal(next.orders.length,1);assert.equal(next.pagination.hasMore,false);assert.notEqual(next.orders[0].instructionKey,page.orders[0].instructionKey);
  assert.equal((await c.query('SELECT count(*) FROM dusk_ingestion.order_instruction_observations')).rows[0].count,'4');
}));
test('contradictory finalized evidence is retained but blocks coverage and reads',()=>transaction(async c=>{
  assert.equal(await observe(c,[0]),true);assert.equal(await observe(c,[0],'cancel_leverage_order',signature,first+2),false);
  assert.equal((await c.query('SELECT count(*) FROM dusk_ingestion.order_instruction_observations')).rows[0].count,'2');
  await reject(c,()=>scan(c,[receipt([[0]])]));await assert.rejects(readOrderHistory(c,query),/contradictory/);
}));
test('a completed empty receipt cannot later hide an observed order',()=>transaction(async c=>{
  await scan(c,[receipt([],signature,true)]);assert.equal(await observe(c,[0]),false);
  await assert.rejects(readOrderHistory(c,query),/contradicts completed scan/);
}));
