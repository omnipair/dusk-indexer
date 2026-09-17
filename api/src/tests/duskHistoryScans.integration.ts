/** Disposable PostgreSQL only; every checkpoint and event rolls back. */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { PoolClient } from 'pg';
import pool from '../config/database';
import { loadPinnedProtocol } from '../config/duskProtocol';

if (process.env.DUSK_ALLOW_DISPOSABLE_DB_TESTS !== 'true' || !process.env.DATABASE_URL)
  throw new Error('Set DUSK_ALLOW_DISPOSABLE_DB_TESTS=true and a disposable DATABASE_URL');
after(() => pool.end());
const pin = loadPinnedProtocol(),signature = '2'.repeat(88),blockhash = '3'.repeat(44);
async function setup(client: PoolClient) {
  const revision = `scan-${randomUUID()}`, first=pin.historyFirstSlot;
  const body=JSON.stringify({revision,cluster:{name:pin.cluster,genesisHash:pin.genesisHash},programs:[pin.dusk,pin.leverageDelegate].map(p=>({
    name:p.name,programId:p.programId,binary:{sha256:p.binarySha256},idl:{canonicalSha256:p.idlCanonicalSha256},deployment:p.deployment
  }))});
  await client.query('SELECT dusk_ingestion.record_deployment_interval($1,$2,$3,$4,$5,$6)',[pin.cluster,revision,first,first+100,createHash('sha256').update(body).digest('hex'),body]);
  const id=[pin.cluster,pin.dusk.programId,pin.dusk.idlCanonicalSha256,revision];
  await client.query('INSERT INTO dusk_ingestion.protocol_identities VALUES($1,$2,$3,$4,now())',id);
  return {id,first};
}
type Fixture=Awaited<ReturnType<typeof setup>>;
async function insert(client:PoolClient,f:Fixture,from=f.first,through=f.first+10,receipts:unknown[]=[],boundary=f.first-1) {
  return client.query(`INSERT INTO dusk_ingestion.history_scans(cluster,program_id,idl_hash,protocol_revision,
    from_slot,through_slot,boundary_signature,boundary_slot,through_blockhash,release_block_time,through_block_time,transactions)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'2026-09-01T00:00:00Z','2026-09-02T00:00:00Z',$10)`,
    [...f.id,from,through,signature,boundary,blockhash,JSON.stringify(receipts)]);
}
async function rejected(client:PoolClient,work:()=>Promise<unknown>,pattern=/FINALIZED_INVARIANT/) {
  await client.query('SAVEPOINT rejected'); await assert.rejects(work(),pattern); await client.query('ROLLBACK TO SAVEPOINT rejected');
}
async function transaction(work:(client:PoolClient,f:Fixture)=>Promise<void>) {
  const client=await pool.connect();
  try {await client.query('BEGIN'); await work(client,await setup(client));}
  finally {await client.query('ROLLBACK');client.release();}
}
const receipt=(slot:number,eventKeys:string[]=[],failed=false)=>({signature,slot,blockhash,eventKeys,failed,transactionSha256:'a'.repeat(64)});
async function observe(client:PoolClient,f:Fixture,key='event') {
  const r=await client.query(`INSERT INTO dusk_ingestion.event_observations(cluster,program_id,idl_hash,protocol_revision,event_key,
    transaction_signature,instruction_path,event_ordinal,slot,blockhash,commitment,event_name,payload_hash,source)
    VALUES($1,$2,$3,$4,$5,$6,'{0}',0,$7,$8,'finalized','SwapExecuted',$9,'scan-test') RETURNING observation_id`,
    [...f.id,key,signature,f.first+1,blockhash,'a'.repeat(64)]);
  return ()=>client.query(`INSERT INTO dusk_ingestion.canonical_events(cluster,program_id,idl_hash,protocol_revision,event_key,observation_id,commitment)
    VALUES($1,$2,$3,$4,$5,$6,'finalized')`,[...f.id,key,r.rows[0].observation_id]);
}

test('baseline and quiet intervals advance contiguously; gaps, replay and mutations fail',()=>transaction(async(c,f)=>{
  await rejected(c,()=>insert(c,f,f.first+1));
  await insert(c,f);
  await rejected(c,()=>insert(c,f));
  await rejected(c,()=>insert(c,f,f.first+12,f.first+20));
  await insert(c,f,f.first+11,f.first+20,[],f.first+10);
  await rejected(c,()=>c.query('UPDATE dusk_ingestion.history_scans SET through_slot=through_slot+1 WHERE protocol_revision=$1',[f.id[3]]));
  await rejected(c,()=>c.query('DELETE FROM dusk_ingestion.history_scans WHERE protocol_revision=$1',[f.id[3]]));
}));
test('unknown deployment, future slots, missing boundaries and duplicate transactions are rejected',()=>transaction(async(c,f)=>{
  await rejected(c,()=>insert(c,{...f,id:[...f.id.slice(0,3),'foreign']}));
  await rejected(c,()=>insert(c,f,f.first,f.first+101));
  await rejected(c,()=>insert(c,f,f.first,f.first+10,[],f.first),/check constraint/);
  await rejected(c,()=>insert(c,f,f.first,f.first+10,[receipt(f.first),receipt(f.first)]));
  await rejected(c,()=>insert(c,f,f.first,f.first+10,[receipt(f.first-1)]));
}));
test('coverage waits for event projection and rejects a known event omitted by RPC',()=>transaction(async(c,f)=>{
  const project=await observe(c,f);
  await rejected(c,()=>insert(c,f,f.first,f.first+10,[receipt(f.first+1,['event'])]));
  await project();
  await rejected(c,()=>insert(c,f));
  await rejected(c,()=>insert(c,f,f.first,f.first+10,[receipt(f.first+1,[],true)]));
  await insert(c,f,f.first,f.first+10,[receipt(f.first+1,['event'])]);
}));
test('failed transactions can establish zero events; later contradictions retain observations and halt projection',()=>transaction(async(c,f)=>{
  await insert(c,f,f.first,f.first+10,[receipt(f.first+1,[],true)]);
  const project=await observe(c,f);
  await rejected(c,project);
  assert.equal((await c.query('SELECT count(*) FROM dusk_ingestion.event_observations WHERE protocol_revision=$1',[f.id[3]])).rows[0].count,'1');
}));
test('coverage commit waits for concurrent canonical writes before reconciling the range',async()=>{
  const c=await pool.connect(),writer=await pool.connect();
  try {
    await c.query('BEGIN');const f=await setup(c);
    await writer.query('BEGIN');
    await writer.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))',[`dusk-history|${pin.cluster}|${f.id[3]}`]);
    await c.query("SET LOCAL lock_timeout='100ms'");
    await assert.rejects(insert(c,f),(e:unknown)=>(e as {code:string}).code==='55P03');
  } finally {await c.query('ROLLBACK');await writer.query('ROLLBACK');c.release();writer.release();}
});
