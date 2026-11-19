import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PoolClient } from 'pg';
import pool from '../config/database';
import { canonicalJson,loadPinnedProtocol,sha256 } from '../config/duskProtocol';
import { readPortfolioRetirementWithdrawals } from '../services/duskPortfolioRetirement';
if(process.env.DUSK_ALLOW_DISPOSABLE_DB_TESTS!=='true'||!process.env.DATABASE_URL)throw new Error('A disposable DATABASE_URL is required');
after(()=>pool.end());
const pin=JSON.parse(readFileSync(resolve(__dirname,'../../../protocol/retirement/aa196e3423fd/release.json'),'utf8'));
const identity=[pin.cluster,pin.programId,pin.idlCanonicalSha256,pin.protocolRevision];
const seal='b'.repeat(64),date=new Date('2026-11-19T01:00:00.000Z');
async function transaction(work:(client:PoolClient)=>Promise<void>){const client=await pool.connect();try{await client.query('BEGIN');await work(client);}finally{await client.query('ROLLBACK');client.release();}}
async function fixture(client:PoolClient){
  await client.query(`INSERT INTO dusk_ingestion.protocol_identities(cluster,program_id,idl_hash,protocol_revision) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,identity);
  const definitions=[{name:'LegacyMarketFrozen',payload:{slot:'20'}},{name:'LegacyRetirementBegun',payload:{source_slot:'21',custody:['77','137']}},
    ...pin.owners.map((owner:string)=>({name:'LegacyOwnerCleared',payload:{owner,rent_lamports:'42'}})),
    ...pin.owners.map((owner:string,index:number)=>({name:'LegacyRetirementPaid',payload:{owner,base:String(index+10),quote:String(index+20),treasury:false}})),
    {name:'LegacyRetirementPaid',payload:{owner:pin.treasury,base:'2',quote:'2',treasury:true}}];
  const rows=definitions.map((row,index)=>({eventKey:[...identity,'retirement-fixture-'+index,'1.0.2',0].join('|'),payloadHash:sha256(canonicalJson(row.payload)),slot:20+index,...row}));
  const archive={schemaVersion:'dusk-retirement-receipt-archive.v2',localOnly:false,contentSha256:seal,sourceCommit:pin.sourceCommit,
    protocolIdentity:{cluster:pin.cluster,programId:pin.programId,idlHash:pin.idlCanonicalSha256,protocolRevision:pin.protocolRevision,genesisHash:pin.genesisHash},
    deployment:{deploySlot:10},verifiedThroughSlot:100,verified:{completed:true,masks:[63,63]}};
  await client.query(`INSERT INTO dusk_ingestion.retirement_archives(cluster,program_id,idl_hash,protocol_revision,archive_sha256,market,helper_deploy_slot,verified_through_slot,archive,expected_events)
    VALUES($1,$2,$3,$4,$5,$6,10,100,$7,$8)`,[...identity,seal,pin.market,JSON.stringify(archive),JSON.stringify(rows.map(({eventKey,payloadHash,slot})=>({eventKey,payloadHash,slot})))]);
  return rows;
}
async function event(client:PoolClient,row:Awaited<ReturnType<typeof fixture>>[number]){
  const observation=(await client.query(`INSERT INTO dusk_ingestion.event_observations(cluster,program_id,idl_hash,protocol_revision,event_key,transaction_signature,
    instruction_path,event_ordinal,slot,blockhash,parent_slot,commitment,event_name,payload_hash,decoded_payload,raw_event,source,observed_at)
    VALUES($1,$2,$3,$4,$5,$6,'{1,0,2}',0,$7::bigint,'retirement-fixture-block',$7::bigint-1,'finalized',$8,$9,$10,$11,'disposable-retirement-test',now()) RETURNING observation_id`,
    [...identity,row.eventKey,row.eventKey.split('|')[4],row.slot,row.name,row.payloadHash,JSON.stringify(row.payload),Buffer.from(canonicalJson(row.payload))])).rows[0].observation_id;
  await client.query(`INSERT INTO dusk_ingestion.canonical_events(cluster,program_id,idl_hash,protocol_revision,event_key,observation_id,commitment) VALUES($1,$2,$3,$4,$5,$6,'finalized')`,[...identity,row.eventKey,observation]);
  await client.query(`INSERT INTO dusk_ingestion.event_stream(time,cluster,program_id,idl_hash,protocol_revision,event_key,transaction_signature,slot,event_name,payload)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[date,...identity,row.eventKey,row.eventKey.split('|')[4],row.slot,row.name,JSON.stringify(row.payload)]);
}
test('terminal withdrawal history stays unavailable through partial ingestion and retains exact native amounts after reconciliation',()=>transaction(async client=>{
  const rows=await fixture(client);
  for(const row of rows.slice(0,-1))await event(client,row);
  assert.deepEqual(await readPortfolioRetirementWithdrawals(client,{owner:pin.owners[0]},[loadPinnedProtocol()]),[]);
  await event(client,rows.at(-1)!);
  const paid=await readPortfolioRetirementWithdrawals(client,{owner:pin.owners[0]},[loadPinnedProtocol()]);
  assert.equal(paid.length,1);assert.equal(paid[0].kind,'market-retirement');assert.equal(paid[0].direction,'withdrawal');
  assert.deepEqual(paid[0].assets,[{mint:pin.baseMint,decimals:6,amount:'10'},{mint:pin.quoteMint,decimals:6,amount:'20'}]);
  assert.equal(paid[0].valuation.usd,null);assert.equal(paid[0].provenance.protocolRevision,pin.protocolRevision);
  assert.equal(paid[0].provenance.retiredIdentity.protocolRevision,loadPinnedProtocol().revision);
  assert.deepEqual(await readPortfolioRetirementWithdrawals(client,{owner:pin.treasury},[loadPinnedProtocol()]),[]);
  assert.deepEqual(await readPortfolioRetirementWithdrawals(client,{owner:pin.owners[0],since:'2026-11-20T00:00:00Z'},[loadPinnedProtocol()]),[]);
  assert.equal((await client.query('SELECT count(*)::int AS n FROM dusk_ingestion.retirement_payouts')).rows[0].n,7);
  assert.equal((await client.query(`SELECT count(*)::int AS n FROM dusk_ingestion.ingestion_cursors WHERE protocol_revision=$1`,[pin.protocolRevision])).rows[0].n,0);
}));
test('an archive cannot be rewritten and a changed canonical payout never becomes a different withdrawal',()=>transaction(async client=>{
  const rows=await fixture(client);for(const row of rows)await event(client,row);
  await client.query('SAVEPOINT no_archive_rewrite');
  await assert.rejects(client.query('UPDATE dusk_ingestion.retirement_archives SET archive_sha256=$1',['a'.repeat(64)]),/immutable/);
  await client.query('ROLLBACK TO SAVEPOINT no_archive_rewrite');
  await client.query('SAVEPOINT no_canonical_rewrite');
  await assert.rejects(client.query(`UPDATE dusk_ingestion.event_observations SET decoded_payload=jsonb_set(decoded_payload,'{base}','"999"') WHERE event_key=$1`,[rows.at(-2)!.eventKey]),/FINALIZED_INVARIANT/);
  await client.query('ROLLBACK TO SAVEPOINT no_canonical_rewrite');
  assert.equal((await readPortfolioRetirementWithdrawals(client,{owner:pin.owners[0]},[loadPinnedProtocol()]))[0].assets[0].amount,'10');
}));
