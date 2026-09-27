import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { PoolClient } from 'pg';
import pool from '../config/database';
import { loadPinnedProtocol } from '../config/duskProtocol';
import { readYieldRates } from '../services/duskYieldRates';
import { Q64 } from './duskYieldCheckpointFixtures';
import { key, observedMarket, streamedIdentity, streamedSwapSnapshot, useFixtureReferences } from './duskStreamedFixtures';

if (process.env.DUSK_ALLOW_DISPOSABLE_DB_TESTS !== 'true' || !process.env.DATABASE_URL)
  throw new Error('A disposable DATABASE_URL is required');
after(() => pool.end());
useFixtureReferences();
const pin = loadPinnedProtocol();
const query = { since: '2026-09-01T01:00:00Z',until: '2026-09-02T01:00:00Z',deploymentIdentitySha256: '1'.repeat(64) };

async function transaction(work: (client: PoolClient) => Promise<void>) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO dusk_ingestion.protocol_identities(cluster,program_id,idl_hash,protocol_revision)
      VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,streamedIdentity);
    await work(client);
  } finally { await client.query('ROLLBACK'); client.release(); }
}
/** Swap snapshots at both boundaries: one quote per base, the quote mint
 * referenced at $1, and a day of swap and interest growth. */
async function seed(client: PoolClient,options: { start?: boolean; startTime?: string; mints?: { baseMint: string; quoteMint: string } } = {}) {
  const common = { baseReserve: 100_000_000_000n,quoteReserve: 100_000_000n,ylpSupply: 1_000_000n,baseSpotNad: 1_000_000_000n,...options.mints };
  if (options.start !== false) await streamedSwapSnapshot(client,{ ...common,slot: 900_000_010,time: options.startTime ?? query.since });
  await streamedSwapSnapshot(client,{ ...common,slot: 900_200_010,time: query.until,baseSwapIndex: 4n*Q64,quoteInterestIndex: 2n*Q64+Q64/2n });
}

test('yield rates come from swap snapshots at each boundary and their own quotes',() => transaction(async client => {
  await seed(client);
  const data = await readYieldRates(client,query);
  assert.equal(data.markets.length,1);
  const row = data.markets[0];
  assert.equal(row.market,observedMarket.market); assert.equal(row.lpMint,observedMarket.ylp);
  assert.equal(row.rates.swapRatePct,'0.1825');
  assert.equal(row.rates.interestRatePct,'91.25');
  assert.equal(row.rates.claimableRatePct,'91.4325');
  assert.equal(row.provenance.startSlot,'900000010');
  assert.equal(row.provenance.initialPrice?.sourceSlot,'900000010');
  assert.match(row.provenance.startContentHash,/^[0-9a-f]{64}$/);
  assert.equal(data.coverage.commitment,'confirmed'); assert.equal(data.coverage.fullApyAvailable,false);
  assert.equal(data.coverage.selectionHash,(await readYieldRates(client,query)).coverage.selectionHash);
}));

test('a quiet market keeps its last committed snapshot beyond the old age bounds',() => transaction(async client => {
  await seed(client,{ startTime: '2026-08-31T22:00:00Z' });
  const data = await readYieldRates(client,query);
  assert.equal(data.markets.length,1);
  assert.equal(data.markets[0].provenance.startSlot,'900000010');
  assert.equal(data.window.maxSnapshotAgeSeconds,null);
  assert.equal(data.window.maxPriceAgeSeconds,null);
}));

test('unpriced growth retains token index deltas without a fabricated USD rate',() => transaction(async client => {
  await seed(client,{ mints: { baseMint: key(150),quoteMint: key(151) } });
  const data = await readYieldRates(client,query);
  assert.equal(data.markets.length,1);
  assert.equal(data.markets[0].rates.claimableRatePct,null);
  assert.equal(data.markets[0].rates.missingMints.length,2);
  assert.equal(data.markets[0].rates.deltas[0].swapIndexDeltaQ64,Q64.toString());
}));

test('one-sided and different-market windows remain unmeasured',() => transaction(async client => {
  await seed(client,{ start: false });
  assert.equal((await readYieldRates(client,query)).markets.length,0);
  assert.equal((await readYieldRates(client,{ ...query,since: query.until,until: '2026-09-03T01:00:00Z' })).markets.length,0);
  assert.equal((await readYieldRates(client,{ ...query,market: pin.dusk.programId })).markets.length,0);
}));

test('zero-length, too-short, excessive and malformed windows are rejected',() => transaction(async client => {
  for (const until of [query.since,'2026-09-01T01:59:59Z','2027-09-01T00:00:00Z','bad'])
    await assert.rejects(readYieldRates(client,{ ...query,until }),/Invalid recorded yield window/);
}));
