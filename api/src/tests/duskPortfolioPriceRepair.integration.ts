import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { PoolClient } from 'pg';
import pool from '../config/database';
import { loadPinnedProtocol } from '../config/duskProtocol';
import { repairPortfolioPriceBatch, repairPortfolioPriceHistory, PortfolioPriceRepairOptions } from '../services/duskPortfolioPriceRepair';
import { historicalIdentity } from '../services/duskHistoricalPriceMath';
import { projectPortfolioCapture, projectPortfolioSource, readPortfolioHistory, storePortfolioCapture } from '../services/duskPortfolioSnapshots';
import { portfolioFixture } from './duskPortfolioFixtures';
import { fixtureKey } from './duskYieldCheckpointFixtures';

if (process.env.DUSK_ALLOW_DISPOSABLE_DB_TESTS !== 'true' || !process.env.DATABASE_URL) throw new Error('A disposable DATABASE_URL is required');
after(() => pool.end());
const pin = loadPinnedProtocol(),active = [pin.cluster,pin.dusk.programId,pin.dusk.idlCanonicalSha256,pin.revision];
const at = '2026-09-02T00:00:00.000Z',now = () => new Date('2026-09-02T00:05:00Z');
async function transaction(work: (client: PoolClient) => Promise<void>) {
  const client = await pool.connect();
  try { await client.query('BEGIN'); await client.query(`INSERT INTO dusk_ingestion.protocol_identities(cluster,program_id,idl_hash,protocol_revision)
    VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,active); await work(client); }
  finally { await client.query('ROLLBACK'); client.release(); }
}
async function seed(client: PoolClient,options: Parameters<typeof portfolioFixture>[0] = {},time = at) {
  const fixture = portfolioFixture({ references: false,...options });
  fixture.source.groups[0].blockTime = fixture.source.groups[0].observedAt = fixture.source.observedAt = fixture.source.catalog.streamTime = time;
  const captureId = await storePortfolioCapture(client,fixture.source); await projectPortfolioCapture(client,captureId);
  const mints = [...new Set(projectPortfolioSource(fixture.source).owners.flatMap(owner => owner.components.flatMap(component => component.balances.map(balance => balance.mint))))];
  const fetchPrices: NonNullable<PortfolioPriceRepairOptions['fetchPrices']> = async (mint,_from,_until,request) => {
    assert.equal(request?.resolution,'1m');
    return [{ mint,provider: 'birdeye',timestamp: new Date(Math.floor(Date.parse(time)/60000)*60000),priceUsd: mint === mints[0] ? 2.5 : 1 }];
  };
  return { ...fixture,captureId,fetchPrices,mints };
}
async function rejected(client: PoolClient,operation: () => Promise<unknown>,message: RegExp) {
  await client.query('SAVEPOINT rejected_repair');
  try { await assert.rejects(operation(),message); } finally { await client.query('ROLLBACK TO SAVEPOINT rejected_repair'); }
}
const query = (owner: string) => ({ owner,limit: 100,offset: 0,sampleSeconds: 3600 });

test('dated repair rebuilds the API view and revision, preserving every original capture and checkpoint',() => transaction(async client => {
  const fixture = await seed(client),before = await readPortfolioHistory(client,query(fixture.owner));
  const original = (await client.query('SELECT source,content_hash FROM dusk_ingestion.portfolio_capture_observations WHERE capture_id=$1',[fixture.captureId])).rows;
  const checkpoint = (await client.query('SELECT components,valuations FROM dusk_ingestion.portfolio_checkpoints WHERE capture_id=$1',[fixture.captureId])).rows;
  assert.equal(before.coverage.unvaluedSnapshots,1);
  const repaired = await repairPortfolioPriceBatch(client,{ now,fetchPrices: fixture.fetchPrices });
  assert.equal(repaired.repairedCheckpoints,1); assert.equal(repaired.unresolvedCheckpoints,0); assert.equal(repaired.providerRequests,2);
  const after = await readPortfolioHistory(client,query(fixture.owner));
  assert.equal(after.coverage.unvaluedSnapshots,0); assert.equal(after.coverage.repairedSnapshots,1);
  assert.equal(after.snapshots[0].valuations.netPositionValueUsd,'51.95');
  assert.equal(after.snapshots[0].capturedAt,at); assert.equal(after.snapshots[0].captureId,fixture.captureId);
  assert.equal(after.snapshots[0].coverage.historicalPriceRepair.basis,'birdeye-minute.v1');
  assert.notEqual(after.coverage.selectionHash,before.coverage.selectionHash);
  assert.deepEqual((await client.query('SELECT source,content_hash FROM dusk_ingestion.portfolio_capture_observations WHERE capture_id=$1',[fixture.captureId])).rows,original);
  assert.deepEqual((await client.query('SELECT components,valuations FROM dusk_ingestion.portfolio_checkpoints WHERE capture_id=$1',[fixture.captureId])).rows,checkpoint);
  assert.equal((await client.query('SELECT count(*)::int AS n FROM dusk_ingestion.price_observations')).rows[0].n,0);
}));
test('dry-run fetches dated prices and previews repairs without writes or retry changes',() => transaction(async client => {
  const fixture = await seed(client),before = await readPortfolioHistory(client,query(fixture.owner));
  const repaired = await repairPortfolioPriceBatch(client,{ now,fetchPrices: fixture.fetchPrices,dryRun: true });
  assert.equal(repaired.repairedCheckpoints,1); assert.equal(repaired.dryRun,true);
  for (const table of ['historical_price_points','portfolio_price_repairs','portfolio_price_repair_attempts'])
    assert.equal((await client.query(`SELECT count(*)::int AS n FROM dusk_ingestion.${table}`)).rows[0].n,0);
  assert.deepEqual(await readPortfolioHistory(client,query(fixture.owner)),before);
}));
test('repair is idempotent and cached points repair another capture without HTTP calls',() => transaction(async client => {
  const fixture = await seed(client);
  await repairPortfolioPriceBatch(client,{ now,fetchPrices: fixture.fetchPrices });
  const repeated = await repairPortfolioPriceBatch(client,{ now,fetchPrices: async () => { throw new Error('Unexpected HTTP'); } });
  assert.equal(repeated.examinedCaptures,0); assert.equal(repeated.providerRequests,0);
  const later = await seed(client,{ slot: 910_000_002 },'2026-09-02T00:00:30.000Z');
  const repaired = await repairPortfolioPriceBatch(client,{ now,fetchPrices: async () => { throw new Error('Unexpected HTTP'); } });
  assert.equal(repaired.providerRequests,0); assert.equal(repaired.repairedCheckpoints,1);
  assert.equal((await readPortfolioHistory(client,query(later.owner))).coverage.repairedSnapshots,2);
}));
test('a provider outage remains a gap, backs off, and later repairs automatically',() => transaction(async client => {
  const fixture = await seed(client);
  const failed = await repairPortfolioPriceBatch(client,{ now,fetchPrices: async () => null });
  assert.equal(failed.providerFailures,2); assert.equal(failed.unresolvedCheckpoints,1);
  const early = await repairPortfolioPriceBatch(client,{ now,fetchPrices: fixture.fetchPrices });
  assert.equal(early.examinedCaptures,0);
  assert.equal((await readPortfolioHistory(client,query(fixture.owner))).coverage.unvaluedSnapshots,1);
  const later = await repairPortfolioPriceBatch(client,{ now: () => new Date('2026-09-02T00:10:00Z'),fetchPrices: fixture.fetchPrices });
  assert.equal(later.repairedCheckpoints,1);
  assert.equal((await readPortfolioHistory(client,query(fixture.owner))).coverage.unvaluedSnapshots,0);
}));
test('an older unavailable capture cannot starve a new gap during retry backoff',() => transaction(async client => {
  await seed(client); await repairPortfolioPriceBatch(client,{ now,fetchPrices: async () => null });
  const later = await seed(client,{ slot: 910_000_002 },'2026-09-02T00:01:00.000Z');
  const repair = await repairPortfolioPriceBatch(client,{ now,fetchPrices: later.fetchPrices });
  assert.equal(repair.examinedCaptures,1); assert.equal(repair.repairedCheckpoints,1);
  const history = await readPortfolioHistory(client,query(later.owner));
  assert.equal(history.coverage.unvaluedSnapshots,1); assert.equal(history.coverage.repairedSnapshots,1);
}));
test('unavailable previews and immature captures are never fabricated from provider prices',() => transaction(async client => {
  const fixture = await seed(client,{ previewUnavailable: true });
  const repair = await repairPortfolioPriceBatch(client,{ now,fetchPrices: fixture.fetchPrices });
  assert.equal(repair.providerRequests,0); assert.equal(repair.repairedCheckpoints,0); assert.equal(repair.unresolvedCheckpoints,1);
  const young = await seed(client,{ slot: 910_000_002 },'2026-09-02T00:04:00.000Z');
  const early = await repairPortfolioPriceBatch(client,{ now,fetchPrices: young.fetchPrices });
  assert.equal(early.examinedCaptures,0);
}));
test('a provider response outside its mint/time window does not publish a repair',() => transaction(async client => {
  const fixture = await seed(client);
  const repair = await repairPortfolioPriceBatch(client,{ now,fetchPrices: async mint => [{ mint,provider: 'birdeye',timestamp: new Date('2026-09-02T00:01:00Z'),priceUsd: 999 }] });
  assert.equal(repair.providerFailures,2); assert.equal(repair.repairedCheckpoints,0);
  assert.equal((await readPortfolioHistory(client,query(fixture.owner))).coverage.unvaluedSnapshots,1);
}));
test('database guards reject changed balances, falsified price evidence, updates and deletes',() => transaction(async client => {
  const fixture = await seed(client); await repairPortfolioPriceBatch(client,{ now,fetchPrices: fixture.fetchPrices });
  const record = (await client.query('SELECT * FROM dusk_ingestion.portfolio_price_repairs WHERE capture_id=$1',[fixture.captureId])).rows[0];
  async function insert(components: unknown,evidence: unknown) {
    return client.query(`INSERT INTO dusk_ingestion.portfolio_price_repairs(capture_id,owner,policy,source_hash,repaired_at,components,valuations,price_evidence,content_hash)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[record.capture_id,record.owner,record.policy,record.source_hash,record.repaired_at,
      JSON.stringify(components),JSON.stringify(record.valuations),JSON.stringify(evidence),record.content_hash]);
  }
  const changed = structuredClone(record.components); changed[0].balances[0].amount='999999999';
  await rejected(client,() => insert(changed,record.price_evidence),/changed captured positions/);
  const evidence = structuredClone(record.price_evidence); evidence[0].contentHash='0'.repeat(64);
  await rejected(client,() => insert(record.components,evidence),/dated price evidence/);
  for (const table of ['historical_price_points','portfolio_price_repairs']) {
    await rejected(client,() => client.query(`UPDATE dusk_ingestion.${table} SET content_hash=repeat('0',64)`),/immutable/);
    await rejected(client,() => client.query(`DELETE FROM dusk_ingestion.${table}`),/immutable/);
  }
}));
test('the per-cycle provider budget is bounded and missing assets remain explicit',() => transaction(async client => {
  const fixture = await seed(client);
  const repair = await repairPortfolioPriceBatch(client,{ now,maxRequests: 1,fetchPrices: fixture.fetchPrices });
  assert.equal(repair.providerRequests,1); assert.equal(repair.repairedCheckpoints,0); assert.equal(repair.unresolvedCheckpoints,1);
  assert.equal((await readPortfolioHistory(client,query(fixture.owner))).coverage.unvaluedSnapshots,1);
}));

test('borrow and LP owners sharing a capture retain separate histories and provenance',() => transaction(async client => {
  const holder = fixtureKey(245).toBase58(),fixture = await seed(client,{ lpOwner: holder });
  const repaired = await repairPortfolioPriceBatch(client,{ now,fetchPrices: fixture.fetchPrices });
  assert.equal(repaired.repairedCheckpoints,2);
  const borrower = await readPortfolioHistory(client,query(fixture.owner)),lp = await readPortfolioHistory(client,query(holder));
  assert.deepEqual(borrower.snapshots[0].components.map((component: any) => component.kind),['borrow']);
  assert.deepEqual(lp.snapshots[0].components.map((component: any) => component.kind),['srlp']);
  assert.equal(borrower.snapshots[0].valuations.netPositionValueUsd,'1.95');
  assert.equal(lp.snapshots[0].valuations.netPositionValueUsd,'50');
}));

test('another worker holding the identity-scoped advisory lock prevents a concurrent cycle',() => transaction(async client => {
  const lock = `dusk:portfolio-price-repair:${JSON.stringify(historicalIdentity())}`;
  await client.query('SELECT pg_advisory_lock(hashtextextended($1,0))',[lock]);
  try {
    const blocked = await repairPortfolioPriceHistory({ now,fetchPrices: async () => { throw new Error('Unexpected HTTP'); } });
    assert.equal(blocked.busy,true); assert.equal(blocked.providerRequests,0); assert.equal(blocked.examinedCaptures,0);
  } finally { await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[lock]); }
}));

test('multi-bank capture times crossing a six-hour batch boundary make progress over successive cycles',() => transaction(async client => {
  const fixture = portfolioFixture({ references: false });
  const group = fixture.source.groups[0],laterBank = portfolioFixture({ references: false,slot: group.slot+1 }).source.groups[0];
  fixture.source.groups = [{ ...group,accounts: [group.accounts[0]] },{ ...laterBank,
    blockTime: '2026-09-02T00:05:00.000Z',observedAt: '2026-09-02T00:05:05.000Z',accounts: [laterBank.accounts[1]] }];
  fixture.source.observedAt='2026-09-02T00:05:05.000Z'; fixture.source.maxCatalogAgeSeconds=600;
  await projectPortfolioCapture(client,await storePortfolioCapture(client,fixture.source));
  const later = await seed(client,{ slot: 910_000_010 },'2026-09-02T06:04:00.000Z');
  const fetchPrices: NonNullable<PortfolioPriceRepairOptions['fetchPrices']> = async (mint,start,end) => {
    assert.ok(end.getTime()-start.getTime()<=6*3600_000);
    const points = [];
    for (let time=start.getTime(); time<=end.getTime(); time+=60_000)
      points.push({ mint,provider: 'birdeye' as const,timestamp: new Date(time),priceUsd: mint===later.mints[0] ? 2.5 : 1 });
    return points;
  };
  const first = await repairPortfolioPriceBatch(client,{ now: () => new Date('2026-09-02T12:00:00Z'),fetchPrices });
  assert.equal(first.repairedCheckpoints,1); assert.equal(first.unresolvedCheckpoints,1);
  const second = await repairPortfolioPriceBatch(client,{ now: () => new Date('2026-09-02T12:05:00Z'),fetchPrices });
  assert.equal(second.repairedCheckpoints,1); assert.equal(second.unresolvedCheckpoints,0);
  assert.equal((await readPortfolioHistory(client,query(later.owner))).coverage.unvaluedSnapshots,0);
}));
