/** Disposable PostgreSQL only: every event fixture rolls back. */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { PoolClient } from 'pg';
import pool from '../config/database';
import { readQuoteHistory, readQuoteHistoryRequest } from '../services/duskQuoteHistory';
import { key, observedMarket, streamedIdentity, streamedSwapSnapshot } from './duskStreamedFixtures';

if (process.env.DUSK_ALLOW_DISPOSABLE_DB_TESTS !== 'true' || !process.env.DATABASE_URL)
  throw new Error('A disposable DATABASE_URL is required');
after(() => pool.end());
async function transaction(work: (client: PoolClient) => Promise<void>) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO dusk_ingestion.protocol_identities(cluster,program_id,idl_hash,protocol_revision)
      VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,streamedIdentity);
    await work(client);
  } finally { await client.query('ROLLBACK'); client.release(); }
}
const query = { market: observedMarket.market,side: 'base' as const,since: '2026-09-02T00:00:00Z',until: '2026-09-02T00:03:00Z',
  resolutionSeconds: 60,deploymentIdentitySha256: 'b'.repeat(64) };
const observe = (client: PoolClient,slot: number,time: string,baseSpotNad: bigint,extra: Parameters<typeof streamedSwapSnapshot>[1] extends infer O ? Partial<O> : never = {}) =>
  streamedSwapSnapshot(client,{ slot,time,baseSpotNad,...extra });

test('candles take OHLC from swap snapshots in slot order and leave gaps and zero quotes unfilled',() => transaction(async client => {
  await observe(client,900_600_003,'2026-09-02T00:00:40Z',2_000_000_000n);
  await observe(client,900_600_001,'2026-09-02T00:00:10Z',2_500_000_000n);
  await observe(client,900_600_002,'2026-09-02T00:00:10Z',3_000_000_000n,{ baseEmaNad: 2_400_000_000n });
  await observe(client,900_600_004,'2026-09-02T00:00:50Z',0n);
  await observe(client,900_600_005,'2026-09-02T00:02:05Z',1_500_000_000n,{ baseEmaNad: 1_600_000_000n });
  const result = await readQuoteHistory(client,query);
  assert.deepEqual(result.candles.map(c => [c.time,c.open.price,c.high.price,c.low.price,c.close.price,c.oracleClose?.price ?? null]),
    [[1788307200,'2.5','3','2','2',null],[1788307320,'1.5','1.5','1.5','1.5','1.6']]);
  assert.equal(result.candles[0].open.sourceSlot,'900600001'); assert.match(result.candles[0].open.sourceHash,/^[0-9a-f]{64}$/);
  assert.equal(result.coverage.samples,'5'); assert.equal(result.coverage.unavailableSamples,'1');
  assert.equal(result.coverage.commitment,'confirmed'); assert.equal(result.coverage.basis,'sampled-program-spot-quotes.v1');
  assert.deepEqual(result.binding,{ baseMint: observedMarket.baseMint,quoteMint: observedMarket.quoteMint,baseDecimals: 9,quoteDecimals: 6 });
}));

test('the other side uses its own quote and bindings come from MarketCreated',() => transaction(async client => {
  await observe(client,900_600_010,'2026-09-02T00:00:10Z',2_500_000_000n,{ quoteSpotNad: 400_000_000n,quoteEmaNad: 410_000_000n });
  const inverse = await readQuoteHistory(client,{ ...query,side: 'quote' });
  assert.equal(inverse.candles[0].close.price,'0.4'); assert.equal(inverse.candles[0].oracleClose?.price,'0.41');
  await observe(client,900_600_011,'2026-09-02T00:00:20Z',2_500_000_000n,{ baseMint: key(170) });
  const history = await readQuoteHistory(client,query);
  assert.equal(history.binding?.baseMint,observedMarket.baseMint);
}));

test('openStart is the opening swap\'s pre-trade price on the open\'s own capture',() => transaction(async client => {
  // Devnet market ogZU's first two swaps, inserted out of order: 1.0 -> 1.019 -> 0.740.
  await observe(client,900_600_032,'2026-09-02T00:00:40Z',740_348_120n,{ quoteSpotNad: 1_350_715_930n,startPriceNad: 1_019_035_720n });
  await observe(client,900_600_031,'2026-09-02T00:00:20Z',1_019_035_720n,{ quoteSpotNad: 981_319_869n,startPriceNad: 999_999_999n });
  // A later event in the opening slot is not that slot's sample.
  await observe(client,900_600_031,'2026-09-02T00:00:20Z',2_000_000_000n,{ quoteSpotNad: 500_000_000n,startPriceNad: 1_900_000_000n });
  // This bucket opens on a swap without a start price; a later swap's start price does not stand in.
  await observe(client,900_600_033,'2026-09-02T00:02:05Z',1_500_000_000n,{ quoteSpotNad: 666_666_666n });
  await observe(client,900_600_034,'2026-09-02T00:02:30Z',1_400_000_000n,{ quoteSpotNad: 714_285_714n,startPriceNad: 1_500_000_000n });
  const base = await readQuoteHistory(client,query);
  assert.deepEqual(base.candles.map(c => [c.time,c.open.price,c.close.price]),
    [[1788307200,'1.01903572','0.74034812'],[1788307320,'1.5','1.4']]);
  assert.equal(base.candles[0].open.sourceSlot,'900600031');
  assert.deepEqual(base.candles[0].openStart,{ ...base.candles[0].open,price: '0.999999999' });
  assert.equal(base.candles[1].openStart,null);
  const quote = await readQuoteHistory(client,{ ...query,side: 'quote' });
  assert.deepEqual(quote.candles.map(c => [c.open.price,c.close.price]),[['0.981319869','1.35071593'],['0.666666666','0.714285714']]);
  // floor(1e18 / 999999999)
  assert.deepEqual(quote.candles[0].openStart,{ ...quote.candles[0].open,price: '1.000000001' });
  assert.equal(quote.candles[1].openStart,null);
  assert.equal(base.schemaVersion,'dusk-quote-history.v1'); assert.equal(base.coverage.basis,'sampled-program-spot-quotes.v1');
}));

test('incremental refresh widens to a late observation\'s bucket and rejects a regressed revision',() => transaction(async client => {
  await observe(client,900_600_020,'2026-09-02T00:02:10Z',2_000_000_000n);
  const first = await readQuoteHistory(client,query);
  await observe(client,900_600_019,'2026-09-02T00:00:30Z',2_200_000_000n);
  const update = await readQuoteHistoryRequest(client,query,{ afterRevision: first.revision,afterUntil: query.until }) as { history: { window: { since: string }; candles: unknown[] }; revision: string };
  assert.equal(update.history.window.since,'2026-09-02T00:00:00.000Z');
  assert.equal(update.history.candles.length,2);
  assert.notEqual(update.revision,first.revision);
  await assert.rejects(readQuoteHistoryRequest(client,query,{ afterRevision: (BigInt(update.revision)+1n).toString(),afterUntil: query.until }),/regressed/);
}));
