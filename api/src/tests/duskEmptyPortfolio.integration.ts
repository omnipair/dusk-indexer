import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import type { PoolClient } from 'pg';
import pool from '../config/database';
import { canonicalJson,sha256,loadPinnedProtocol } from '../config/duskProtocol';
import { projectPortfolioCapture,storePortfolioCapture,readEmptyPortfolioOwners,captureDuskPortfolioSnapshots } from '../services/duskPortfolioSnapshots';
import { assertMarketCatalogConsistency } from '../services/duskEmptyPortfolio';
import type { EmptyMarketEvidence } from '../services/duskEmptyPortfolio';
import { portfolioRevisionIdentity } from '../services/duskPortfolioHistoryRevisions';
import { emptyPortfolioFixture } from './duskEmptyPortfolioFixtures';
import { portfolioFixture } from './duskPortfolioFixtures';
import { fixtureKey } from './duskYieldCheckpointFixtures';
import { streamedRelease } from './duskStreamedFixtures';
if(process.env.DUSK_ALLOW_DISPOSABLE_DB_TESTS!=='true'||!process.env.DATABASE_URL)throw new Error('A disposable DATABASE_URL is required');
after(()=>pool.end());
const pin=loadPinnedProtocol(),scope=portfolioRevisionIdentity(pin);
async function transaction(work:(client:PoolClient)=>Promise<void>){const client=await pool.connect();try{
  await client.query('BEGIN');await client.query(`INSERT INTO dusk_ingestion.protocol_identities(cluster,program_id,idl_hash,protocol_revision)
    VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,scope);await work(client);
}finally{await client.query('ROLLBACK');client.release();}}
async function catalog(client:PoolClient,evidence:EmptyMarketEvidence){
  return (await client.query(`INSERT INTO dusk_ingestion.portfolio_market_catalog_observations
    (cluster,program_id,idl_hash,protocol_revision,slot,blockhash,observed_at,source,content_hash)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING observation_id::text`,[...scope,evidence.slot,evidence.blockhash,evidence.observedAt,
      JSON.stringify(evidence),sha256(canonicalJson([scope,evidence]))])).rows[0].observation_id as string;
}
test('empty capture requires its previously persisted exact finalized observation and retains zero income',()=>transaction(async client=>{
  const source=emptyPortfolioFixture();source.emptyCatalog!.observationId='999999999999';
  const missing=await storePortfolioCapture(client,source);await assert.rejects(projectPortfolioCapture(client,missing),/FINALIZED_INVARIANT/);
  source.emptyCatalog!.observationId=await catalog(client,source.emptyCatalog!.evidence);
  const id=await storePortfolioCapture(client,source);assert.equal(await projectPortfolioCapture(client,id),1);
  assert.equal(await projectPortfolioCapture(client,id),1);
  const checkpoint=(await client.query('SELECT valuations,components FROM dusk_ingestion.portfolio_checkpoints WHERE capture_id=$1',[id])).rows[0];
  assert.equal(checkpoint.valuations.netPositionValueUsd,'0');assert.deepEqual(checkpoint.components,[]);
  assert.deepEqual((await client.query('SELECT income FROM dusk_ingestion.portfolio_income_checkpoints WHERE capture_id=$1',[id])).rows[0].income,{streams:[],unavailable:[]});
}));
test('contradictory finalized catalog observations are both retained and halt projection',()=>transaction(async client=>{
  const source=emptyPortfolioFixture();source.emptyCatalog!.observationId=await catalog(client,source.emptyCatalog!.evidence);
  const id=await storePortfolioCapture(client,source);
  await catalog(client,{...source.emptyCatalog!.evidence,markets:[fixtureKey(235).toBase58()]});
  await assert.rejects(projectPortfolioCapture(client,id),/contradictory finalized/);
  assert.equal((await client.query('SELECT count(*)::int AS n FROM dusk_ingestion.portfolio_market_catalog_observations')).rows[0].n,2);
  assert.equal((await client.query('SELECT count(*)::int AS n FROM dusk_ingestion.portfolio_capture_projections WHERE capture_id=$1',[id])).rows[0].n,0);
}));
test('empty catalog conflicts with actual market bytes only at the same finalized slot and identity',()=>transaction(async client=>{
  const source=emptyPortfolioFixture();await catalog(client,source.emptyCatalog!.evidence);
  const later=portfolioFixture({slot:source.emptyCatalog!.evidence.slot+1}).source;
  await storePortfolioCapture(client,later);await assertMarketCatalogConsistency(client);
  await storePortfolioCapture(client,portfolioFixture().source);
  await assert.rejects(assertMarketCatalogConsistency(client),/contradictory finalized/);
}));
test('only verified historical identities supply owner addresses for empty portfolios',()=>transaction(async client=>{
  const source=portfolioFixture().source,id=await storePortfolioCapture(client,source);await projectPortfolioCapture(client,id);
  const archived={...pin,revision:pin.revision+'-empty-test',dusk:{...pin.dusk,idlCanonicalSha256:'1'.repeat(64)}};
  const unknown={...pin,revision:pin.revision+'-unknown-empty-test',dusk:{...pin.dusk,idlCanonicalSha256:'2'.repeat(64)}};
  const oldOwner=fixtureKey(235).toBase58(),unknownOwner=fixtureKey(236).toBase58();
  for(const [revision,owner] of [[archived,oldOwner],[unknown,unknownOwner]] as const){
    const identity=portfolioRevisionIdentity(revision);await client.query(`INSERT INTO dusk_ingestion.protocol_identities(cluster,program_id,idl_hash,protocol_revision) VALUES($1,$2,$3,$4)`,identity);
    const archivedSource=JSON.parse(JSON.stringify(source));archivedSource.catalog.knownOwners=[owner];
    const archivedCapture=(await client.query(`INSERT INTO dusk_ingestion.portfolio_capture_observations
      (cluster,program_id,idl_hash,protocol_revision,source_min_slot,source_max_slot,capture_time,observed_at,deployment_identity_sha256,source,content_hash)
      SELECT $1,$2,$3,$4,source_min_slot,source_max_slot,capture_time,observed_at,deployment_identity_sha256,$5,content_hash
      FROM dusk_ingestion.portfolio_capture_observations WHERE capture_id=$6 RETURNING capture_id::text`,[...identity,JSON.stringify(archivedSource),id])).rows[0].capture_id;
    await client.query(`INSERT INTO dusk_ingestion.portfolio_checkpoints(cluster,program_id,idl_hash,protocol_revision,owner,bucket,observed_at,source_min_slot,source_max_slot,components,coverage,valuations,capture_id)
      SELECT $1,$2,$3,$4,$5,bucket,observed_at,source_min_slot,source_max_slot,'[]'::jsonb,coverage,valuations,$6
      FROM dusk_ingestion.portfolio_checkpoints WHERE capture_id=$7`,[...identity,owner,archivedCapture,id]);
  }
  assert.deepEqual(await readEmptyPortfolioOwners(client,[pin,archived]),[source.catalog.knownOwners[0],oldOwner].sort());
}));
test('worker stores full RPC catalogs before refusing zero when stream discovery is behind',async t=>transaction(async client=>{
  const slot=910_000_001,time=new Date(Date.now()-5000);await streamedRelease(client,{slot:slot-1,time});
  const wrapper={query:(sql:string,...args:any[])=>/^(BEGIN|COMMIT|ROLLBACK)/.test(sql)?Promise.resolve({rows:[]}):client.query(sql,...args as [any]),release:()=>{}};
  t.mock.method(pool,'connect',async()=>wrapper);t.mock.method(pool,'query',(...args:any[])=>client.query(...args as [any]));
  const evidence=emptyPortfolioFixture().emptyCatalog!.evidence;
  evidence.slot=slot;evidence.blockTime=time.toISOString();evidence.observedAt=new Date().toISOString();evidence.markets=[fixtureKey(235).toBase58()];
  const dependencies={envelope:async()=>({programDataSlot:'1',leverageDelegateProgramDataSlot:'1',deploymentIdentitySha256:evidence.deploymentIdentitySha256}),captureCatalog:async()=>evidence};
  await assert.rejects(captureDuskPortfolioSnapshots(dependencies as any),/await stream discovery/);
  assert.equal((await client.query('SELECT count(*)::int AS n FROM dusk_ingestion.portfolio_market_catalog_observations')).rows[0].n,1);
  assert.equal((await client.query('SELECT count(*)::int AS n FROM dusk_ingestion.portfolio_checkpoints')).rows[0].n,0);
}));
test('worker records genuine zero after verified absence and keeps the previously observed wallet',async t=>transaction(async client=>{
  const prior=portfolioFixture().source,previousId=await storePortfolioCapture(client,prior);await projectPortfolioCapture(client,previousId);
  const slot=910_000_101,time=new Date(Date.now()-5000);await streamedRelease(client,{slot:slot-1,time});
  const wrapper={query:(sql:string,...args:any[])=>/^(BEGIN|COMMIT|ROLLBACK)/.test(sql)?Promise.resolve({rows:[]}):client.query(sql,...args as [any]),release:()=>{}};
  t.mock.method(pool,'connect',async()=>wrapper);t.mock.method(pool,'query',(...args:any[])=>client.query(...args as [any]));
  const evidence=emptyPortfolioFixture().emptyCatalog!.evidence;evidence.slot=slot;evidence.blockTime=time.toISOString();evidence.observedAt=new Date().toISOString();
  const result=await captureDuskPortfolioSnapshots({envelope:async()=>({programDataSlot:'1',leverageDelegateProgramDataSlot:'1',deploymentIdentitySha256:evidence.deploymentIdentitySha256}),captureCatalog:async()=>evidence} as any);
  assert.equal(result.markets,0);assert.equal(result.owners,1);assert.equal(result.minSlot,slot);
  const current=(await client.query('SELECT owner,valuations FROM dusk_ingestion.portfolio_checkpoints WHERE capture_id=$1',[result.captureId])).rows[0];
  assert.equal(current.owner,prior.catalog.knownOwners[0]);assert.equal(current.valuations.netPositionValueUsd,'0');
  assert.equal((await client.query('SELECT count(*)::int AS n FROM dusk_ingestion.portfolio_checkpoints WHERE capture_id=$1',[previousId])).rows[0].n,1);
}));
test('a replacement market discovered before the first empty capture still retains approved archived owner addresses only',()=>transaction(async client=>{
  const time=new Date(Date.now()-5000);await streamedRelease(client,{slot:910_000_100,time});
  const {streamedMarket}=await import('./duskStreamedFixtures');await streamedMarket(client);
  const source=portfolioFixture().source,id=await storePortfolioCapture(client,source);await projectPortfolioCapture(client,id);
  const archived={...pin,revision:pin.revision+'-retired-owner-candidate',dusk:{...pin.dusk,idlCanonicalSha256:'4'.repeat(64)}};
  const identity=portfolioRevisionIdentity(archived),owner=fixtureKey(235).toBase58();
  await client.query(`INSERT INTO dusk_ingestion.protocol_identities(cluster,program_id,idl_hash,protocol_revision) VALUES($1,$2,$3,$4)`,identity);
  const archivedSource=JSON.parse(JSON.stringify(source));archivedSource.catalog.knownOwners=[owner];
  const capture=(await client.query(`INSERT INTO dusk_ingestion.portfolio_capture_observations
    (cluster,program_id,idl_hash,protocol_revision,source_min_slot,source_max_slot,capture_time,observed_at,deployment_identity_sha256,source,content_hash)
    SELECT $1,$2,$3,$4,source_min_slot,source_max_slot,capture_time,observed_at,deployment_identity_sha256,$5,content_hash
    FROM dusk_ingestion.portfolio_capture_observations WHERE capture_id=$6 RETURNING capture_id::text`,[...identity,JSON.stringify(archivedSource),id])).rows[0].capture_id;
  await client.query(`INSERT INTO dusk_ingestion.portfolio_checkpoints(cluster,program_id,idl_hash,protocol_revision,owner,bucket,observed_at,source_min_slot,source_max_slot,components,coverage,valuations,capture_id)
    SELECT $1,$2,$3,$4,$5,bucket,observed_at,source_min_slot,source_max_slot,'[]'::jsonb,coverage,valuations,$6
    FROM dusk_ingestion.portfolio_checkpoints WHERE capture_id=$7`,[...identity,owner,capture,id]);
  const {readPortfolioCatalog}=await import('../services/duskPortfolioSnapshots');
  const current=await readPortfolioCatalog(client,false,[pin,archived]);
  assert.equal(current.markets.length,1);assert.ok(current.knownOwners.includes(owner));assert.deepEqual(current.items,[]);
  assert.ok(!(await readPortfolioCatalog(client)).knownOwners.includes(owner),'Unregistered old identities remain excluded');
}));

test('batched zero income retains an independently hashed checkpoint for every owner',()=>transaction(async client=>{
  const source=emptyPortfolioFixture();source.catalog.knownOwners.push(fixtureKey(237).toBase58());
  source.emptyCatalog!.observationId=await catalog(client,source.emptyCatalog!.evidence);
  const original=client.query.bind(client);let incomeWrites=0;
  client.query=(async(text:string,values?:any[])=>{
    if(/^INSERT INTO dusk_ingestion\.portfolio_income_checkpoints/.test(text))incomeWrites++;
    return original(text,values);
  }) as typeof client.query;
  try {
    const id=await storePortfolioCapture(client,source);assert.equal(await projectPortfolioCapture(client,id),2);
    assert.equal(incomeWrites,1);
    const rows=(await original('SELECT owner,source_hash,income,content_hash FROM dusk_ingestion.portfolio_income_checkpoints WHERE capture_id=$1',[id])).rows;
    assert.equal(rows.length,2);assert.equal(new Set(rows.map(r=>r.owner)).size,2);
    for(const row of rows){assert.deepEqual(row.income,{streams:[],unavailable:[]});
      assert.equal(row.content_hash,sha256(canonicalJson([id,row.owner,row.source_hash,row.income])));}
  } finally {client.query=original;}
}));
