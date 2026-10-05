import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { PoolClient } from 'pg';
import pool from '../config/database';
import { loadPinnedProtocol } from '../config/duskProtocol';
import { readTrailingYlpRate, readYieldRates } from '../services/duskYieldRates';
import { Q64 } from './duskYieldCheckpointFixtures';
import { key, observedMarket, streamedEvent, streamedIdentity, streamedSwapSnapshot, useFixtureReferences } from './duskStreamedFixtures';

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

const DAY = 86400_000;
const live = { market: observedMarket.market,ylpMint: observedMarket.ylp,baseMint: observedMarket.baseMint,
  quoteMint: observedMarket.quoteMint,baseDecimals: 9,quoteDecimals: 6 };
const trailing = (client: PoolClient,windowMs: number,until = query.until,market = live) =>
  readTrailingYlpRate(client,{ deploymentIdentitySha256: query.deploymentIdentitySha256,until: Date.parse(until),windowMs,market });

test('trailing rates match the bracketed rate over the same window and spread it over a longer one',() => transaction(async client => {
  await seed(client);
  assert.deepEqual(await trailing(client,DAY),
    { market: observedMarket.market,swapRatePct: '0.1825',interestRatePct: '91.25',growth: 'recorded' });
  // The market's first swap opens a two-day window: one day of growth over two.
  const twoDays = await trailing(client,2*DAY);
  assert.equal(twoDays.swapRatePct,'0.09125');
  assert.equal(twoDays.interestRatePct,'45.625');
}));

test('a market created before the stream is measured from the swaps the stream holds',() => transaction(async client => {
  const swap = (slot: number,time: string,baseSwapIndex: bigint,quoteInterestIndex: bigint) =>
    streamedEvent(client,'SwapExecuted',{ market: observedMarket.market,slot: String(slot),trader: key(117),
      ylp_supply: '1000000',base_live_reserve: '100000000000',quote_live_reserve: '100000000',
      base: { spot_price_nad: '1000000000',price_ema_nad: '0',swap_fee_growth_index_q64: baseSwapIndex.toString(),
        interest_growth_index_q64: (2n*Q64).toString() },
      quote: { spot_price_nad: '0',price_ema_nad: '0',swap_fee_growth_index_q64: (3n*Q64).toString(),
        interest_growth_index_q64: quoteInterestIndex.toString() } },slot,time);
  await swap(900_000_010,query.since,3n*Q64,2n*Q64);
  await swap(900_200_010,query.until,4n*Q64,2n*Q64+Q64/2n);
  assert.equal((await client.query(`SELECT 1 FROM dusk_ingestion.streamed_markets WHERE market=$1`,[observedMarket.market])).rowCount,0);
  assert.deepEqual(await trailing(client,DAY),
    { market: observedMarket.market,swapRatePct: '0.1825',interestRatePct: '91.25',growth: 'recorded' });
}));

test('a quiet market is measured at zero growth instead of being left out',() => transaction(async client => {
  await seed(client,{ start: false });
  const none = { market: observedMarket.market,swapRatePct: '0',interestRatePct: '0',growth: 'none' };
  assert.deepEqual(await trailing(client,DAY),none);
  // The same last swap still stands for the market a week later.
  assert.deepEqual(await trailing(client,DAY,'2026-09-09T01:00:00Z'),none);
  // A market that never swapped earns nothing.
  assert.deepEqual(await trailing(client,DAY,query.until,{ ...live,market: key(230) }),{ ...none,market: key(230) });
}));

test('trailing windows outside one hour to ninety days are rejected',() => transaction(async client => {
  for (const windowMs of [3599_999,91*DAY,Number.NaN])
    await assert.rejects(trailing(client,windowMs),/Invalid trailing yield window/);
}));
