import test from 'node:test';
import assert from 'node:assert/strict';
import { QueryResult, QueryResultRow } from 'pg';
import { getMarketValueBaselines, normalizeMarketValueBaselineRange } from '../services/marketValueBaselineService';

function mockResult<T extends QueryResultRow = any>(rows: QueryResultRow[]): QueryResult<T> {
  return {
    rows: rows as T[],
    rowCount: rows.length,
    command: 'SELECT',
    oid: 0,
    fields: [],
  };
}

function createMockDb(options: { missingTokenBPrice?: boolean } = {}) {
  const statements: string[] = [];
  const baseline = new Date('2026-05-10T10:00:00Z');

  const db = {
    async query<T extends QueryResultRow = any>(text: string): Promise<QueryResult<T>> {
      statements.push(text);

      if (text.includes('FROM pools')) {
        return mockResult<T>([
          {
            id: 1,
            pair_address: 'pair-a',
            token0: 'token-a',
            token1: 'token-b',
          },
        ]);
      }

      if (text.includes('FROM token_price_snapshots')) {
        return mockResult<T>([
          {
            mint: 'token-a',
            bucket: baseline,
            price_usd: '2',
            decimals: 6,
            provider: 'birdeye',
            quality: 'historical',
          },
          {
            mint: 'token-b',
            bucket: baseline,
            price_usd: options.missingTokenBPrice ? '0' : '5',
            decimals: 6,
            provider: 'birdeye',
            quality: options.missingTokenBPrice ? 'missing' : 'historical',
          },
        ]);
      }

      if (text.includes("'swaps' AS source") && text.includes('UNION ALL')) {
        return mockResult<T>([
          {
            pair: 'pair-a',
            reserve0: '100000000',
            reserve1: '200000000',
            timestamp: new Date('2026-05-10T09:55:00Z'),
            source: 'swaps',
          },
        ]);
      }

      if (text.includes('DISTINCT ON (pair)') && text.includes('cash_reserve0')) {
        return mockResult<T>([
          {
            pair: 'pair-a',
            rate0: '20000000',
            rate1: '10000000',
            cash_reserve0: '60000000',
            cash_reserve1: '80000000',
            timestamp: new Date('2026-05-10T09:50:00Z'),
          },
        ]);
      }

      if (text.includes('FROM adjust_debt_events')) {
        return mockResult<T>([
          {
            pair: 'pair-a',
            debt0: '5000000',
            debt1: '0',
          },
        ]);
      }

      if (text.includes('AS interest0') && text.includes('FROM update_pair_events')) {
        return mockResult<T>([
          {
            pair: 'pair-a',
            interest0: '1000000',
            interest1: '0',
          },
        ]);
      }

      if (text.includes("interval '24 hours'")) {
        return mockResult<T>([
          {
            pair: 'pair-a',
            value_usd: '77',
          },
        ]);
      }

      if (text.includes('COALESCE(SUM(COALESCE(lp_fee_usd, 0) + COALESCE(protocol_fee_usd, 0)), 0)::text AS value_usd')) {
        return mockResult<T>([
          {
            pair: 'pair-a',
            value_usd: '11',
          },
        ]);
      }

      if (text.includes('weekly_fee0')) {
        return mockResult<T>([
          {
            pair: 'pair-a',
            weekly_fee0: '7000000',
            weekly_fee1: '0',
            avg_reserve0: '100000000',
            avg_reserve1: '200000000',
          },
        ]);
      }

      if (text.includes('weekly_lp_interest0')) {
        return mockResult<T>([
          {
            pair: 'pair-a',
            weekly_lp_interest0: '3500000',
            weekly_lp_interest1: '0',
            avg_reserve0: '100000000',
            avg_reserve1: '200000000',
          },
        ]);
      }

      if (text.includes('FROM user_position_updated_events')) {
        return mockResult<T>([
          {
            pair: 'pair-a',
            collateral0: '1000000',
            collateral1: '0',
          },
        ]);
      }

      if (text.includes('AS total_volume_usd')) {
        return mockResult<T>([
          {
            total_volume_usd: '200',
          },
        ]);
      }

      return mockResult<T>([]);
    },
  };

  return { db, statements };
}

test('normalizes supported market value baseline ranges', () => {
  assert.deepEqual(normalizeMarketValueBaselineRange(undefined), { range: '2H', windowHours: 2 });
  assert.deepEqual(normalizeMarketValueBaselineRange('7d'), { range: '7D', windowHours: 168 });
  assert.throws(() => normalizeMarketValueBaselineRange('30M'), /Unsupported range/);
});

test('value baselines use stored DB prices without external historical fetches', async () => {
  const { db, statements } = createMockDb();

  const result = await getMarketValueBaselines(db, {
    range: '2H',
    now: new Date('2026-05-10T12:00:00Z'),
  });

  assert.equal(result.baselineAt, '2026-05-10T10:00:00.000Z');
  assert.equal(result.priceProvider, 'token_price_snapshots');
  assert.equal(result.pools['pair-a'].metrics.virtualLiquidityUsd.value, 1200);
  assert.equal(result.pools['pair-a'].metrics.tvlUsd.value, 520);
  assert.equal(result.tokens['token-a'].metrics.priceUsd.value, 2);
  assert.equal(statements.some((statement) => statement.includes('FROM token_price_snapshots')), true);
  assert.equal(statements.some((statement) => statement.includes('INSERT INTO token_price_snapshots')), false);
  assert.equal(statements.some((statement) => statement.includes('fetchBirdeye')), false);
});

test('missing price snapshots return missing baseline metrics', async () => {
  const { db } = createMockDb({ missingTokenBPrice: true });

  const result = await getMarketValueBaselines(db, {
    range: '2H',
    now: new Date('2026-05-10T12:00:00Z'),
  });

  assert.equal(result.tokens['token-b'].metrics.priceUsd.quality, 'missing');
  assert.equal(result.pools['pair-a'].metrics.virtualLiquidityUsd.value, null);
  assert.equal(result.pools['pair-a'].metrics.virtualLiquidityUsd.quality, 'missing');
});

test('latest historical reserve event is selected for pool baselines', async () => {
  const { db, statements } = createMockDb();

  const result = await getMarketValueBaselines(db, {
    range: '2H',
    now: new Date('2026-05-10T12:00:00Z'),
  });

  assert.equal(result.pools['pair-a'].metrics.reserves.token0.value, 100);
  assert.equal(result.pools['pair-a'].metrics.reserves.token1.value, 200);
  assert.equal(result.pools['pair-a'].metrics.reserves.token0.source, 'swaps');
  assert.equal(
    statements.some((statement) => statement.includes('ORDER BY pair, timestamp DESC, slot DESC')),
    true
  );
});

test('debt baseline is estimated and includes accrued interest', async () => {
  const { db } = createMockDb();

  const result = await getMarketValueBaselines(db, {
    range: '2H',
    now: new Date('2026-05-10T12:00:00Z'),
  });

  assert.equal(result.pools['pair-a'].metrics.totalDebtUsd.value, 12);
  assert.equal(result.pools['pair-a'].metrics.totalDebtUsd.quality, 'estimated');
  assert.equal(result.protocol.metrics.totalBorrowedUsd.value, 12);
  assert.equal(result.protocol.metrics.totalBorrowedUsd.quality, 'estimated');
});

test('rolling volume and APY windows are calculated around the selected baseline', async () => {
  const { db, statements } = createMockDb();

  const result = await getMarketValueBaselines(db, {
    range: '2H',
    now: new Date('2026-05-10T12:00:00Z'),
  });

  assert.equal(result.pools['pair-a'].metrics.volume24hUsd.value, 77);
  assert.ok((result.pools['pair-a'].metrics.apr.value ?? 0) > 0);
  assert.equal(statements.some((statement) => statement.includes("interval '24 hours'")), true);
  assert.equal(statements.some((statement) => statement.includes("interval '7 days'")), true);
});
