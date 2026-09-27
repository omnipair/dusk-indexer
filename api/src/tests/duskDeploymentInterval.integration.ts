/** Disposable PostgreSQL only. Every registration and observation is rolled back. */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash,randomUUID } from 'node:crypto';
import { PoolClient } from 'pg';
import pool from '../config/database';
import { loadPinnedProtocol } from '../config/duskProtocol';

if (process.env.DUSK_ALLOW_DISPOSABLE_DB_TESTS!=='true' || !process.env.DATABASE_URL)
  throw new Error('Set DUSK_ALLOW_DISPOSABLE_DB_TESTS=true and a disposable DATABASE_URL');
after(() => pool.end());
const pinned=loadPinnedProtocol();
function fixture() {
  const revision=`deployment-test-${randomUUID()}`;
  const pin={revision,cluster:{name:pinned.cluster,genesisHash:pinned.genesisHash},programs:[pinned.dusk,pinned.leverageDelegate].map(program=>({
    name:program.name,programId:program.programId,binary:{sha256:program.binarySha256},
    idl:{sha256:program.idlRawSha256,canonicalSha256:program.idlCanonicalSha256},deployment:program.deployment,
  }))};
  return {revision,pin,first:pinned.historyFirstSlot,through:pinned.historyFirstSlot+100};
}
type Fixture=ReturnType<typeof fixture>;
async function register(client:PoolClient,value:Fixture) {
  const body=JSON.stringify(value.pin),hash=createHash('sha256').update(body).digest('hex');
  await client.query('SELECT dusk_ingestion.record_deployment_interval($1,$2,$3,$4,$5,$6)',
    [pinned.cluster,value.revision,value.first,value.through,hash,body]);
}
async function identity(client:PoolClient,value:Fixture,hash=pinned.dusk.idlCanonicalSha256) {
  await client.query('INSERT INTO dusk_ingestion.protocol_identities(cluster,program_id,idl_hash,protocol_revision) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
    [pinned.cluster,pinned.dusk.programId,hash,value.revision]);
}
async function source(client:PoolClient,value:Fixture,slot:number,hash=pinned.dusk.idlCanonicalSha256) {
  const key=randomUUID();
  await client.query(`INSERT INTO dusk_ingestion.event_observations
    (cluster,program_id,idl_hash,protocol_revision,event_key,transaction_signature,instruction_path,event_ordinal,slot,blockhash,commitment,payload_hash,source)
    VALUES($1,$2,$3,$4,$5,$5,'{0}',0,$6,$5,'finalized',$7,'deployment-boundary-test')`,
    [pinned.cluster,pinned.dusk.programId,hash,value.revision,key,slot,'a'.repeat(64)]);
  return key;
}
async function transaction(work:(client:PoolClient,value:Fixture)=>Promise<void>) {
  const client=await pool.connect(),value=fixture();
  try { await client.query('BEGIN'); await identity(client,value); await work(client,value); }
  finally {await client.query('ROLLBACK');client.release();}
}
async function rejected(client:PoolClient,work:()=>Promise<unknown>) {
  await client.query('SAVEPOINT expected_rejection');
  await assert.rejects(work(),/FINALIZED_INVARIANT/);
  await client.query('ROLLBACK TO SAVEPOINT expected_rejection');
}

// Streamed confirmed events land past the last attested finalized slot.
test('registered release accepts events from its first slot on and rejects old and foreign-IDL events',()=>transaction(async(client,value)=>{
  await register(client,value);
  await source(client,value,value.first); await source(client,value,value.through);
  await rejected(client,()=>source(client,value,value.first-1));
  await source(client,value,value.through+1);
  const foreign='b'.repeat(64); await identity(client,value,foreign);
  await rejected(client,()=>source(client,value,value.first,foreign));
  assert.equal((await client.query('SELECT count(*) FROM dusk_ingestion.event_observations WHERE protocol_revision=$1',[value.revision])).rows[0].count,'3');
}));

test('deployment identity is immutable and the verified upper bound only advances',()=>transaction(async(client,value)=>{
  await register(client,value); await register(client,value);
  const changed=structuredClone(value);
  changed.pin.programs[0].deployment={...changed.pin.programs[0].deployment,upgradeAuthority:pinned.dusk.programId};
  await rejected(client,()=>register(client,changed));
  value.through+=20; await register(client,value); await source(client,value,value.through);
  await rejected(client,()=>client.query('UPDATE dusk_ingestion.deployment_intervals SET first_slot=first_slot+1 WHERE protocol_revision=$1',[value.revision]));
  await rejected(client,()=>client.query('UPDATE dusk_ingestion.deployment_intervals SET verified_through_slot=verified_through_slot-1 WHERE protocol_revision=$1',[value.revision]));
  await rejected(client,()=>client.query('DELETE FROM dusk_ingestion.deployment_intervals WHERE protocol_revision=$1',[value.revision]));
}));

test('contaminated current-revision history blocks registration and remains unchanged',()=>transaction(async(client,value)=>{
  const key=await source(client,value,value.first-1);
  await rejected(client,()=>register(client,value));
  const row=(await client.query('SELECT protocol_revision,slot FROM dusk_ingestion.event_observations WHERE event_key=$1',[key])).rows[0];
  assert.equal(row.protocol_revision,value.revision); assert.equal(Number(row.slot),value.first-1);
  const clean=fixture(); await identity(client,clean); await register(client,clean);
  assert.equal((await client.query('SELECT count(*) FROM dusk_ingestion.deployment_intervals WHERE protocol_revision=$1',[value.revision])).rows[0].count,'0');
}));

test('cursor registration starts at the deployment floor and streams past the verified bound',()=>transaction(async(client,value)=>{
  await register(client,value);
  const args=[pinned.cluster,pinned.dusk.programId,pinned.dusk.idlCanonicalSha256,value.revision];
  await client.query(`INSERT INTO dusk_ingestion.ingestion_cursors(cluster,program_id,idl_hash,protocol_revision,stream_name,commitment,next_slot)
    VALUES($1,$2,$3,$4,'test','finalized',$5)`,[...args,value.first]);
  await rejected(client,()=>client.query(`UPDATE dusk_ingestion.ingestion_cursors SET next_slot=$2,last_observed_slot=$3,last_finalized_slot=$3,last_signature='old' WHERE protocol_revision=$1`,[value.revision,value.first,value.first-1]));
  await client.query(`UPDATE dusk_ingestion.ingestion_cursors SET next_slot=$2,last_observed_slot=$3,last_finalized_slot=$3,last_signature='future' WHERE protocol_revision=$1`,[value.revision,value.through+2,value.through+1]);
  await client.query(`UPDATE dusk_ingestion.ingestion_cursors SET next_slot=$2,last_observed_slot=$3,last_finalized_slot=$3,last_signature='valid' WHERE protocol_revision=$1`,[value.revision,value.first+1,value.first]);
  assert.equal((await client.query('SELECT last_signature FROM dusk_ingestion.ingestion_cursors WHERE protocol_revision=$1',[value.revision])).rows[0].last_signature,'valid');
}));

test('registration waits for an in-flight observation before validating existing history',async()=>{
  const writer=await pool.connect(),registrar=await pool.connect(),value=fixture();
  try {
    await writer.query('BEGIN'); await identity(writer,value); await source(writer,value,value.first-1);
    await registrar.query('BEGIN'); await registrar.query("SET LOCAL lock_timeout='100ms'");
    await assert.rejects(register(registrar,value),(error:unknown)=>(error as {code?:string}).code==='55P03');
  } finally {await writer.query('ROLLBACK');await registrar.query('ROLLBACK');writer.release();registrar.release();}
});
