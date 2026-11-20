import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { SystemProgram } from '@solana/web3.js';
import { PoolClient } from 'pg';
import pool from '../config/database';
import { loadPinnedProtocol } from '../config/duskProtocol';
import { projectPortfolioCapture, projectPortfolioCaptureBatch, projectPortfolioSource, readPortfolioHistory, storePortfolioCapture } from '../services/duskPortfolioSnapshots';
import { portfolioFixture } from './duskPortfolioFixtures';
import { fixtureKey } from './duskYieldCheckpointFixtures';
import { readPortfolioCatalog } from '../services/duskPortfolioSnapshots';
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { PublicKey } from '@solana/web3.js';
import { fixtureMarket, key, streamedEvent, streamedMarket, streamedRelease } from './duskStreamedFixtures';
import { referencePortfolioHistory } from './duskPortfolioHistoryReference';

if (process.env.DUSK_ALLOW_DISPOSABLE_DB_TESTS !== 'true' || !process.env.DATABASE_URL) throw new Error('A disposable DATABASE_URL is required');
after(() => pool.end());
const pin = loadPinnedProtocol(),active = [pin.cluster,pin.dusk.programId,pin.dusk.idlCanonicalSha256,pin.revision];
async function transaction(work: (client: PoolClient) => Promise<void>) {
  const client = await pool.connect();
  try { await client.query('BEGIN'); await client.query(`INSERT INTO dusk_ingestion.protocol_identities(cluster,program_id,idl_hash,protocol_revision)
    VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,active); await work(client); }
  finally { await client.query('ROLLBACK'); client.release(); }
}
const query = (owner: string) => ({ owner,limit: 100,offset: 0 });

// Synthetic persisted-revision fixtures exercise history selection and
// provenance, not decoding an old binary with the active IDL. Production
// history pins come only from byte-verified, committed release archives.
async function archiveCheckpoint(client:PoolClient,sourceId:string,archive:typeof pin,distinctEvidence=false) {
  const tuple=[archive.cluster,archive.dusk.programId,archive.dusk.idlCanonicalSha256,archive.revision];
  await client.query(`INSERT INTO dusk_ingestion.protocol_identities(cluster,program_id,idl_hash,protocol_revision)
    VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,tuple);
  const inserted=await client.query(`INSERT INTO dusk_ingestion.portfolio_capture_observations
    (cluster,program_id,idl_hash,protocol_revision,source_min_slot,source_max_slot,capture_time,observed_at,deployment_identity_sha256,source,content_hash)
    SELECT $1,$2,$3,$4,source_min_slot,source_max_slot,capture_time,observed_at,deployment_identity_sha256,source,content_hash
    FROM dusk_ingestion.portfolio_capture_observations WHERE capture_id=$5 RETURNING capture_id::text`,[...tuple,sourceId]);
  const id=inserted.rows[0].capture_id as string;
  await client.query(`INSERT INTO dusk_ingestion.portfolio_account_evidence(capture_id,account,slot,basis,blockhash,state_hash)
    SELECT $1::bigint,account,slot,basis,blockhash,CASE WHEN $3 THEN encode(sha256(convert_to(state_hash||($1::bigint)::text,'UTF8')),'hex') ELSE state_hash END
    FROM dusk_ingestion.portfolio_account_evidence WHERE capture_id=$2`,[id,sourceId,distinctEvidence]);
  await client.query(`INSERT INTO dusk_ingestion.portfolio_checkpoints
    (cluster,program_id,idl_hash,protocol_revision,owner,bucket,observed_at,source_min_slot,source_max_slot,components,coverage,valuations,capture_id)
    SELECT $1,$2,$3,$4,owner,bucket,observed_at,source_min_slot,source_max_slot,components,coverage,valuations,$5
    FROM dusk_ingestion.portfolio_checkpoints WHERE capture_id=$6`,[...tuple,id,sourceId]);
  await client.query(`INSERT INTO dusk_ingestion.portfolio_capture_projections(capture_id,owner_count)
    SELECT $1,owner_count FROM dusk_ingestion.portfolio_capture_projections WHERE capture_id=$2`,[id,sourceId]);
  return id;
}

test('verified archived history retains per-point identity and pagination without admitting other revisions or replaying them',()=>transaction(async client=>{
  const fixture=portfolioFixture(),id=await storePortfolioCapture(client,fixture.source);
  await projectPortfolioCapture(client,id);
  const archived={...pin,revision:`${pin.revision}-history-test`,dusk:{...pin.dusk,idlCanonicalSha256:'1'.repeat(64)}};
  const old=await archiveCheckpoint(client,id,archived,true);
  const unknown={...pin,revision:`${pin.revision}-unknown-test`,dusk:{...pin.dusk,idlCanonicalSha256:'2'.repeat(64)}};
  await archiveCheckpoint(client,id,unknown);
  const before=await client.query('SELECT * FROM dusk_ingestion.portfolio_capture_observations ORDER BY capture_id');
  const options={...query(fixture.owner),since:'2026-09-02T00:00:00Z',until:'2026-09-02T00:01:00Z'};
  const current=await readPortfolioHistory(client,options);
  assert.deepEqual(current.snapshots.map(row=>row.captureId),[id]);
  const result=await readPortfolioHistory(client,options,[pin,archived]);
  assert.deepEqual(result.snapshots.map(row=>row.captureId),[old,id]);
  assert.equal(result.pagination.total,2);assert.equal(result.coverage.rawTotal,2);
  assert.deepEqual(result.snapshots.map(row=>row.provenance.protocolRevision),[archived.revision,pin.revision]);
  assert.deepEqual(result.snapshots.map(row=>row.provenance.idlSha256),[archived.dusk.idlCanonicalSha256,pin.dusk.idlCanonicalSha256]);
  assert.ok(result.snapshots.every(row=>row.valuations.netPositionValueUsd==='51.95'));
  const page=await readPortfolioHistory(client,{...options,limit:1,offset:1},[pin,archived]);
  assert.deepEqual(page.snapshots.map(row=>row.captureId),[id]);assert.equal(page.coverage.selectionHash,result.coverage.selectionHash);
  assert.equal((await readPortfolioHistory(client,{...options,offset:999},[pin,archived])).pagination.total,2);
  const sampled=await readPortfolioHistory(client,{...options,sampleSeconds:60},[pin,archived]);
  assert.equal(sampled.coverage.rawTotal,2);
  assert.ok(sampled.snapshots.every(row=>[old,id].includes(row.captureId)));
  await assert.rejects(projectPortfolioCapture(client,old),/identity\/hash mismatch/);
  const after=await client.query('SELECT * FROM dusk_ingestion.portfolio_capture_observations ORDER BY capture_id');
  assert.deepEqual(after.rows,before.rows);
}));

test('finalized contradictions in an included archive halt reads while unselected revisions remain isolated',()=>transaction(async client=>{
  const fixture=portfolioFixture(),id=await storePortfolioCapture(client,fixture.source);
  await projectPortfolioCapture(client,id);
  const archived={...pin,revision:`${pin.revision}-conflict-test`,dusk:{...pin.dusk,idlCanonicalSha256:'3'.repeat(64)}};
  const old=await archiveCheckpoint(client,id,archived);
  await client.query(`INSERT INTO dusk_ingestion.portfolio_account_evidence(capture_id,account,slot,basis,blockhash,state_hash)
    SELECT capture_id,account,slot,basis,blockhash,repeat('f',64)
    FROM dusk_ingestion.portfolio_account_evidence WHERE capture_id=$1 LIMIT 1`,[old]);
  assert.equal((await readPortfolioHistory(client,query(fixture.owner))).snapshots.length,1);
  await assert.rejects(readPortfolioHistory(client,query(fixture.owner),[pin,archived]),/FINALIZED_INVARIANT/);
}));

test('single-pass history matches the previous complete response across gaps, ties, owners, filters and empty pages',()=>transaction(async client=>{
  const otherOwner = fixtureKey(178).toBase58(),fixture = portfolioFixture();
  for (const [index,minute] of [0,0,1,2,3,10,60,70].entries()) {
    const value = portfolioFixture({ slot: 910_100_000+index,references: index!==2 && index!==3,
      ...(index===5 ? { lpOwner: otherOwner } : {}),closed: index===7 });
    const time = new Date(Date.parse('2026-09-02T00:00:00Z')+minute*60000).toISOString();
    value.source.groups[0].blockTime = time;
    value.source.groups[0].observedAt = value.source.observedAt = value.source.catalog.streamTime = time;
    await projectPortfolioCapture(client,await storePortfolioCapture(client,value.source));
  }
  await storePortfolioCapture(client,portfolioFixture({ slot: 910_100_100 }).source);
  for (const owner of [fixture.owner,otherOwner,fixtureKey(179).toBase58()])
    for (const sampleSeconds of [0,60,3600])
      for (const offset of [0,2,999]) {
        const options = { owner,sampleSeconds,offset,limit: 3 };
        assert.deepEqual(await readPortfolioHistory(client,options),await referencePortfolioHistory(client,options));
      }
  for (const range of [{ since: '2026-09-02T00:00:01Z' },{ until: '2026-09-02T00:02:00Z' },
    { since: '2026-09-03T00:00:00Z',until: '2026-09-04T00:00:00Z' }]) {
    const options = { ...query(fixture.owner),...range,sampleSeconds: 3600 };
    assert.deepEqual(await readPortfolioHistory(client,options),await referencePortfolioHistory(client,options));
  }
}));

test('portfolio discovery comes from streamed positions and LP holders and keeps past owners',() => transaction(async (client) => {
  // A stream time in the past: the API clamps a cursor ahead of its clock.
  const time = new Date(Math.floor(Date.now()/1000)*1000-5000);
  await streamedRelease(client,{ slot: 900_200_000,time });
  await streamedMarket(client);
  const { market,srlp } = fixtureMarket,[borrower,trader,closer,holder,leaver] = [211,212,213,214,215].map(key);
  const borrow = key(216),open = key(217),closed = key(218);
  await streamedEvent(client,'MarketCollateralDeposited',{ market,position: borrow,owner: borrower,base_collateral: '1',quote_collateral: '0',
    auction_debt_asset: '255' });
  const leverage = (position: string,owner: string) => ({ market,position,owner,debt_asset_mint: fixtureMarket.baseMint,
    collateral_asset_mint: fixtureMarket.quoteMint,collateral_amount: '5',debt_amount: '2',debt_shares: '2',closeout_value: '3' });
  await streamedEvent(client,'LeveragePositionOpened',leverage(open,trader));
  await streamedEvent(client,'LeveragePositionOpened',leverage(closed,closer));
  await streamedEvent(client,'LeveragePositionClosed',leverage(closed,closer));
  await streamedEvent(client,'LiquidityAdded',{ market,owner: holder,srlp_amount: '10' });
  await streamedEvent(client,'LiquidityAdded',{ market,owner: leaver,srlp_amount: '4' });
  await streamedEvent(client,'LpTransferred',{ market,lp_mint: srlp,source_owner: leaver,destination_owner: holder,amount: '4' });
  const catalog = await readPortfolioCatalog(client);
  const ata = getAssociatedTokenAddressSync(new PublicKey(srlp),new PublicKey(holder),true,TOKEN_2022_PROGRAM_ID).toBase58();
  assert.deepEqual(catalog.markets,[market]);
  assert.deepEqual(catalog.items.map(item => [item.kind,item.address,item.owner]).sort(),
    [['borrow',borrow,borrower],['leverage',open,trader],['srlp',ata,holder]].sort());
  for (const owner of [borrower,trader,closer,holder,leaver]) assert.ok(catalog.knownOwners.includes(owner),owner);
  assert.equal(catalog.basis,'streamed-events.v1'); assert.equal(catalog.throughSlot,900_200_000);
  assert.equal(catalog.sourceFloor,900_200_000); assert.equal(catalog.streamTime,time.toISOString());
}));

test('retired devnet releases never enter current portfolio discovery',() => transaction(async (client) => {
  const time = new Date(Math.floor(Date.now()/1000)*1000-5000);
  await streamedRelease(client,{ slot: 900_200_000,time });
  await streamedMarket(client);
  const archived = [pin.cluster,pin.dusk.programId,'1'.repeat(64),`${pin.revision}-archive`];
  await client.query(`INSERT INTO dusk_ingestion.protocol_identities(cluster,program_id,idl_hash,protocol_revision)
    VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,archived);
  const oldMarket = { market: key(219),baseMint: key(220),quoteMint: key(221),srlp: key(222),baseHlp: key(223),quoteHlp: key(224) };
  await streamedMarket(client,oldMarket,900_100_000,archived);
  const owner = key(225),position = key(226);
  await streamedEvent(client,'LeveragePositionOpened',{ market: oldMarket.market,position,owner,
    debt_asset_mint: oldMarket.baseMint,collateral_asset_mint: oldMarket.quoteMint,
    collateral_amount: '5',debt_amount: '2',debt_shares: '2',closeout_value: '3' },900_100_001,undefined,archived);
  const ownerWithoutPosition = key(228);
  await streamedEvent(client,'MarketDebtUpdated',{ market: oldMarket.market,owner: ownerWithoutPosition },
    900_100_002,undefined,archived);
  const catalog = await readPortfolioCatalog(client);
  assert.equal(catalog.basis,'streamed-events.v1');
  assert.deepEqual(catalog.markets,[fixtureMarket.market]);
  assert.deepEqual(catalog.items,[]);
  assert.ok(!catalog.knownOwners.includes(owner));
  assert.ok(!catalog.knownOwners.includes(ownerWithoutPosition));
  assert.equal(catalog.candidateIdentities,undefined);

  // Replay accepts archived addresses only after current-pin market and account
  // evidence is supplied by the capture. An old identity cannot be substituted.
  const fixture = portfolioFixture();
  fixture.source.catalog.basis = 'streamed-event-candidates.v2';
  fixture.source.catalog.candidateIdentities = [{cluster:pin.cluster,programId:pin.dusk.programId,
    idlHash:pin.dusk.idlCanonicalSha256,protocolRevision:pin.revision},
    {cluster:pin.cluster,programId:pin.dusk.programId,idlHash:archived[2],protocolRevision:archived[3]}];
  assert.equal(projectPortfolioSource(fixture.source).owners[0].valuations.quality,'reference-valued');
  fixture.source.catalog.candidateIdentities![1].programId = key(227);
  assert.throws(() => projectPortfolioSource(fixture.source),/candidate identity differs/);
}));

test('saved portfolio evidence replays idempotently without current RPC or price inputs',() => transaction(async (client) => {
  const fixture = portfolioFixture(),id = await storePortfolioCapture(client,fixture.source);
  assert.equal(await storePortfolioCapture(client,{ ...fixture.source,observedAt: '2026-09-02T00:00:10Z' }),id);
  assert.equal(await projectPortfolioCaptureBatch(client),1); assert.equal(await projectPortfolioCaptureBatch(client),0);
  const result = await readPortfolioHistory(client,query(fixture.owner));
  assert.equal(result.snapshots[0].valuations.netPositionValueUsd,'51.95');
  assert.equal(result.snapshots[0].captureId,id); assert.equal(result.coverage.pendingCaptures,'0');
}));

test('a saved empty-system position replays without rewriting evidence or blocking later captures',() => transaction(async (client) => {
  const fixture = portfolioFixture();
  fixture.source.catalog.items[0].kind = 'leverage';
  fixture.source.groups[0].accounts[0].account = { owner: SystemProgram.programId.toBase58(),executable: false,data: '' };
  const first = await storePortfolioCapture(client,fixture.source);
  const before = await client.query('SELECT source,content_hash FROM dusk_ingestion.portfolio_capture_observations WHERE capture_id=$1',[first]);
  const later = await storePortfolioCapture(client,portfolioFixture({ slot: fixture.source.groups[0].slot+1,closed: true }).source);
  assert.equal(await projectPortfolioCaptureBatch(client),2);
  assert.equal(await projectPortfolioCaptureBatch(client),0);
  const checkpoint = await client.query('SELECT components,coverage,valuations FROM dusk_ingestion.portfolio_checkpoints WHERE capture_id=$1',[first]);
  assert.equal(checkpoint.rows[0].components.length,1);
  assert.equal(checkpoint.rows[0].components[0].address,fixture.tokenAddress);
  assert.deepEqual(checkpoint.rows[0].coverage.closedAccounts,[fixture.position]);
  assert.equal(checkpoint.rows[0].valuations.netPositionValueUsd,'50');
  assert.equal((await client.query('SELECT count(*)::int AS total FROM dusk_ingestion.portfolio_capture_projections WHERE capture_id=ANY($1::bigint[])',[[first,later]])).rows[0].total,2);
  const after = await client.query('SELECT source,content_hash FROM dusk_ingestion.portfolio_capture_observations WHERE capture_id=$1',[first]);
  assert.deepEqual(after.rows,before.rows);
}));
test('older backfill, equal block timestamps and closure snapshots all retain history',() => transaction(async (client) => {
  const first = portfolioFixture();
  await projectPortfolioCapture(client,await storePortfolioCapture(client,first.source));
  await projectPortfolioCapture(client,await storePortfolioCapture(client,portfolioFixture({ slot: first.source.groups[0].slot+1,closed: true }).source));
  await storePortfolioCapture(client,portfolioFixture({ slot: first.source.groups[0].slot-1,lpAmount: 200n }).source);
  assert.equal(await projectPortfolioCaptureBatch(client),1);
  const result = await readPortfolioHistory(client,query(first.owner));
  assert.equal(result.snapshots.length,3);
  assert.deepEqual(result.snapshots.map((row) => row.valuations.netPositionValueUsd),['0','51.95','101.95']);
}));
test('sampled history retains actual first and latest captures with stable pagination',() => transaction(async (client) => {
  const ids: string[] = [];
  for (const [index,minute] of [0,10,20,60,70].entries()) {
    const fixture = portfolioFixture({ slot: 910_000_010+index,lpAmount: BigInt(100+index) });
    const time = new Date(Date.parse('2026-09-02T00:00:00Z')+minute*60000).toISOString();
    fixture.source.groups[0].blockTime = time;
    fixture.source.groups[0].observedAt = fixture.source.observedAt = fixture.source.catalog.streamTime = time;
    ids.push(await storePortfolioCapture(client,fixture.source));
    await projectPortfolioCapture(client,ids[index]);
  }
  const options = { ...query(portfolioFixture().owner),sampleSeconds: 3600,until: '2026-09-02T02:00:00Z' };
  const all = await readPortfolioHistory(client,options);
  assert.deepEqual(all.snapshots.map((row) => row.captureId),[ids[4],ids[2],ids[0]]);
  assert.equal(all.coverage.rawTotal,5); assert.equal(all.coverage.unvaluedSnapshots,0);
  assert.equal(all.coverage.firstSnapshotAt,'2026-09-02T00:00:00.000Z');
  assert.equal(all.coverage.lastSnapshotAt,'2026-09-02T01:10:00.000Z');
  const page = await readPortfolioHistory(client,{ ...options,limit: 1,offset: 1 });
  assert.equal(page.coverage.selectionHash,all.coverage.selectionHash);
  assert.equal(page.pagination.total,3); assert.equal(page.snapshots[0].captureId,ids[2]);
  const range = await readPortfolioHistory(client,{ ...options,since: '2026-09-02T00:05:00Z' });
  assert.deepEqual(range.snapshots.map((row) => row.captureId),[ids[4],ids[2],ids[1]]);
  assert.notEqual(range.coverage.selectionHash,all.coverage.selectionHash);
}));
test('sampling exposes unavailable captures even when their display bucket has a later valuation',() => transaction(async (client) => {
  for (let index=0; index<3; index++) {
    const fixture = portfolioFixture({ slot: 910_000_020+index,references: index !== 1 });
    const time = new Date(Date.parse('2026-09-02T00:00:00Z')+index*60000).toISOString();
    fixture.source.groups[0].blockTime = time;
    fixture.source.groups[0].observedAt = fixture.source.observedAt = fixture.source.catalog.streamTime = time;
    await projectPortfolioCapture(client,await storePortfolioCapture(client,fixture.source));
  }
  const result = await readPortfolioHistory(client,{ ...query(portfolioFixture().owner),sampleSeconds: 3600 });
  assert.equal(result.snapshots.length,3);
  assert.deepEqual(result.snapshots.map(row => row.valuations.quality),['reference-valued','incomplete','reference-valued']);
  assert.equal(result.coverage.gapBoundariesRetained,true);
  assert.equal(result.coverage.unvaluedSnapshots,1); assert.equal(result.coverage.rawTotal,3);
}));
test('sampling retains both ends of a missing run and stable pagination without retaining every missing point',()=>transaction(async client=>{
  const ids: string[]=[];
  for(let index=0;index<7;index++) {
    const fixture=portfolioFixture({slot:910_000_030+index,references:index<2 || index>4});
    const time=new Date(Date.parse('2026-09-02T03:00:00Z')+index*60000).toISOString();
    fixture.source.groups[0].blockTime=time;fixture.source.groups[0].observedAt=fixture.source.observedAt=fixture.source.catalog.streamTime=time;
    ids.push(await storePortfolioCapture(client,fixture.source));await projectPortfolioCapture(client,ids[index]);
  }
  const options={...query(portfolioFixture().owner),sampleSeconds:3600};
  const all=await readPortfolioHistory(client,options);
  assert.deepEqual(all.snapshots.map(row=>row.captureId),[ids[6],ids[5],ids[4],ids[2],ids[1],ids[0]]);
  assert.equal(all.coverage.unvaluedSnapshots,3);assert.equal(all.coverage.gapBoundariesRetained,true);
  const page=await readPortfolioHistory(client,{...options,limit:2,offset:2});
  assert.deepEqual(page.snapshots.map(row=>row.captureId),[ids[4],ids[2]]);
  assert.equal(page.coverage.selectionHash,all.coverage.selectionHash);assert.equal(page.pagination.total,6);
}));
test('owner transfer snapshots do not leave the former owner holding the LP value',() => transaction(async (client) => {
  const nextOwner = fixtureKey(178).toBase58(),fixture = portfolioFixture({ lpOwner: nextOwner });
  await projectPortfolioCapture(client,await storePortfolioCapture(client,fixture.source));
  assert.equal((await readPortfolioHistory(client,query(fixture.owner))).snapshots[0].valuations.netPositionValueUsd,'1.95');
  assert.equal((await readPortfolioHistory(client,query(nextOwner))).snapshots[0].valuations.netPositionValueUsd,'50');
  assert.equal((await readPortfolioHistory(client,query(fixtureKey(179).toBase58()))).coverage.available,false);
}));
test('contradictory finalized evidence is retained and disables replay and reads',() => transaction(async (client) => {
  const fixture = portfolioFixture(),first = await storePortfolioCapture(client,fixture.source);
  await projectPortfolioCapture(client,first);
  const other = await storePortfolioCapture(client,portfolioFixture({ lpAmount: 300n }).source);
  await assert.rejects(projectPortfolioCapture(client,other),/FINALIZED_INVARIANT/);
  await assert.rejects(readPortfolioHistory(client,query(fixture.owner)),/FINALIZED_INVARIANT/);
  assert.equal((await client.query('SELECT count(*)::int AS total FROM dusk_ingestion.portfolio_capture_observations WHERE capture_id=ANY($1::bigint[])',[[first,other]])).rows[0].total,2);
}));
test('malformed saved captures cannot partially write a replay batch',() => transaction(async (client) => {
  const good = portfolioFixture(),bad = portfolioFixture({ slot: good.source.groups[0].slot+1 });
  bad.source.groups[0].accounts.pop();
  const first = await storePortfolioCapture(client,good.source),second = await storePortfolioCapture(client,bad.source);
  await client.query('SAVEPOINT replay');
  await assert.rejects(projectPortfolioCaptureBatch(client),/complete catalog/);
  await client.query('ROLLBACK TO SAVEPOINT replay');
  assert.equal((await client.query('SELECT count(*)::int AS total FROM dusk_ingestion.portfolio_checkpoints WHERE capture_id=ANY($1::bigint[])',[[first,second]])).rows[0].total,0);
}));
test('database guards reject substituted owners, slots and updates',() => transaction(async (client) => {
  const fixture = portfolioFixture(),id = await storePortfolioCapture(client,fixture.source);
  await projectPortfolioCapture(client,id);
  await client.query('SAVEPOINT guard');
  await assert.rejects(client.query(`INSERT INTO dusk_ingestion.portfolio_checkpoints
    (cluster,program_id,idl_hash,protocol_revision,owner,bucket,observed_at,source_min_slot,source_max_slot,components,coverage,valuations,capture_id)
    SELECT cluster,program_id,idl_hash,protocol_revision,$2,bucket,observed_at,source_min_slot,source_max_slot,components,coverage,valuations,capture_id
    FROM dusk_ingestion.portfolio_checkpoints WHERE capture_id=$1`,[id,fixtureKey(181).toBase58()]),/FINALIZED_INVARIANT/);
  await client.query('ROLLBACK TO SAVEPOINT guard');
  await assert.rejects(client.query('UPDATE dusk_ingestion.portfolio_checkpoints SET valuations=$2 WHERE capture_id=$1',[id,'{}']),/FINALIZED_INVARIANT/);
  await client.query('ROLLBACK TO SAVEPOINT guard');
  await assert.rejects(client.query(`INSERT INTO dusk_ingestion.portfolio_checkpoints
    (cluster,program_id,idl_hash,protocol_revision,owner,bucket,observed_at,source_min_slot,source_max_slot,components,coverage,valuations,capture_id)
    SELECT cluster,program_id,idl_hash,protocol_revision,owner,bucket,observed_at,source_min_slot,source_max_slot+1,components,coverage,valuations,capture_id
    FROM dusk_ingestion.portfolio_checkpoints WHERE capture_id=$1`,[id]),/FINALIZED_INVARIANT/);
  await client.query('ROLLBACK TO SAVEPOINT guard');
}));

test('portfolio evidence and multiple owner checkpoints are each written as one batch',()=>transaction(async client=>{
  const fixture=portfolioFixture({lpOwner:fixtureKey(178).toBase58()}),counts={evidence:0,checkpoints:0};
  const original=client.query.bind(client);
  client.query=(async(text:string,values?:any[])=>{
    if(/^INSERT INTO dusk_ingestion\.portfolio_account_evidence/.test(text))counts.evidence++;
    if(/^INSERT INTO dusk_ingestion\.portfolio_checkpoints/.test(text))counts.checkpoints++;
    return original(text,values);
  }) as typeof client.query;
  try {
    const id=await storePortfolioCapture(client,fixture.source);
    assert.equal(await projectPortfolioCapture(client,id),2);
    assert.deepEqual(counts,{evidence:1,checkpoints:1});
    const rows=await original('SELECT owner,valuations FROM dusk_ingestion.portfolio_checkpoints WHERE capture_id=$1',[id]);
    assert.equal(rows.rows.length,2);
    assert.equal(rows.rows.find(r=>r.owner===fixture.owner).valuations.netPositionValueUsd,'1.95');
    assert.equal(rows.rows.find(r=>r.owner===fixtureKey(178).toBase58()).valuations.netPositionValueUsd,'50');
  } finally { client.query=original; }
}));
