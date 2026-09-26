import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { SystemProgram } from '@solana/web3.js';
import { PoolClient } from 'pg';
import pool from '../config/database';
import { loadPinnedProtocol } from '../config/duskProtocol';
import { projectPortfolioCapture, projectPortfolioCaptureBatch, readPortfolioHistory, storePortfolioCapture } from '../services/duskPortfolioSnapshots';
import { portfolioFixture } from './duskPortfolioFixtures';
import { fixtureKey } from './duskYieldCheckpointFixtures';
import { readPortfolioCatalog } from '../services/duskPortfolioSnapshots';
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { PublicKey } from '@solana/web3.js';
import { fixtureMarket, key, streamedEvent, streamedMarket, streamedRelease } from './duskStreamedFixtures';

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

test('portfolio discovery comes from streamed positions and LP holders and keeps past owners',() => transaction(async (client) => {
  // A stream time in the past: the API clamps a cursor ahead of its clock.
  const time = new Date(Math.floor(Date.now()/1000)*1000-5000);
  await streamedRelease(client,{ slot: 900_200_000,time });
  await streamedMarket(client);
  const { market,ylp } = fixtureMarket,[borrower,trader,closer,holder,leaver] = [211,212,213,214,215].map(key);
  const borrow = key(216),open = key(217),closed = key(218);
  await streamedEvent(client,'BorrowPositionUpdated',{ market,position: borrow,owner: borrower,base_collateral: '1',quote_collateral: '0',
    fixed_base_shares: '0',fixed_quote_shares: '0',closed: false });
  const leverage = (position: string,owner: string) => ({ market,position,owner,debt_asset_mint: fixtureMarket.baseMint,
    collateral_asset_mint: fixtureMarket.quoteMint,collateral_amount: '5',debt_amount: '2',debt_shares: '2',closeout_value: '3' });
  await streamedEvent(client,'LeveragePositionOpened',leverage(open,trader));
  await streamedEvent(client,'LeveragePositionOpened',leverage(closed,closer));
  await streamedEvent(client,'LeveragePositionClosed',leverage(closed,closer));
  await streamedEvent(client,'LiquidityAdded',{ market,owner: holder,ylp_amount: '10' });
  await streamedEvent(client,'LiquidityAdded',{ market,owner: leaver,ylp_amount: '4' });
  await streamedEvent(client,'LpTransferred',{ market,lp_mint: ylp,source_owner: leaver,destination_owner: holder,amount: '4' });
  const catalog = await readPortfolioCatalog(client);
  const ata = getAssociatedTokenAddressSync(new PublicKey(ylp),new PublicKey(holder),true,TOKEN_2022_PROGRAM_ID).toBase58();
  assert.deepEqual(catalog.markets,[market]);
  assert.deepEqual(catalog.items.map(item => [item.kind,item.address,item.owner]).sort(),
    [['borrow',borrow,borrower],['leverage',open,trader],['ylp',ata,holder]].sort());
  for (const owner of [borrower,trader,closer,holder,leaver]) assert.ok(catalog.knownOwners.includes(owner),owner);
  assert.equal(catalog.basis,'streamed-events.v1'); assert.equal(catalog.throughSlot,900_200_000);
  assert.equal(catalog.sourceFloor,900_200_000); assert.equal(catalog.streamTime,time.toISOString());
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
  assert.equal(result.snapshots.length,2);
  assert.ok(result.snapshots.every((row) => row.valuations.quality === 'reference-valued'));
  assert.equal(result.coverage.unvaluedSnapshots,1); assert.equal(result.coverage.rawTotal,3);
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
