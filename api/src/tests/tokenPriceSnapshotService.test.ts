import test from 'node:test';
import assert from 'node:assert/strict';
import { QueryResult, QueryResultRow } from 'pg';
import {
  backfillHistoricalTokenPricesRange,
  createHistoricalTokenPriceCache,
  getHistoricalTokenPrices,
} from '../services/tokenPriceSnapshotService';

function mockResult<T extends QueryResultRow = any>(rows: QueryResultRow[]): QueryResult<T> {
  return {
    rows: rows as T[],
    rowCount: rows.length,
    command: 'SELECT',
    oid: 0,
    fields: [],
  };
}

test('getHistoricalTokenPrices persists missing markers so later runs do not refetch', async () => {
  const inserts: any[][] = [];
  let fetches = 0;
  const db = {
    async query<T extends QueryResultRow = any>(text: string, params?: any[]): Promise<QueryResult<T>> {
      if (text.includes('SELECT mint, bucket, price_usd')) {
        return mockResult<T>([]);
      }
      if (text.includes('INSERT INTO token_price_snapshots')) {
        inserts.push(params ?? []);
        return mockResult<T>([]);
      }
      return mockResult<T>([]);
    },
  };

  const prices = await getHistoricalTokenPrices(
    db,
    ['missing-token'],
    new Date('2026-05-09T00:15:00Z'),
    {
      getCurrentPrices: async () => new Map(),
      fetchHistoricalPrice: async () => {
        fetches += 1;
        return null;
      },
    }
  );

  assert.equal(fetches, 1);
  assert.equal(prices.get('missing-token')?.quality, 'missing');
  assert.equal(inserts.length, 1);
  assert.deepEqual(inserts[0][0], ['missing-token']);
  assert.deepEqual(inserts[0][2], [0]);
  assert.deepEqual(inserts[0][5], ['missing']);
});

test('backfillHistoricalTokenPricesRange fetches one range per mint and writes missing gaps', async () => {
  const inserts: any[][] = [];
  const db = {
    async query<T extends QueryResultRow = any>(text: string, params?: any[]): Promise<QueryResult<T>> {
      if (text.includes('SELECT mint, bucket, price_usd')) {
        return mockResult<T>([]);
      }
      if (text.includes('INSERT INTO token_price_snapshots')) {
        inserts.push(params ?? []);
        return mockResult<T>([]);
      }
      return mockResult<T>([]);
    },
  };

  const result = await backfillHistoricalTokenPricesRange(
    db,
    ['token-a'],
    new Date('2026-05-09T00:00:00Z'),
    new Date('2026-05-09T02:00:00Z'),
    {
      cache: createHistoricalTokenPriceCache(),
      getCurrentPrices: async () => new Map([[
        'token-a',
        { priceUsd: 9, decimals: 6, quality: 'current' },
      ]]),
      fetchHistoricalPriceRange: async () => [
        {
          mint: 'token-a',
          timestamp: new Date('2026-05-09T01:25:00Z'),
          priceUsd: 1.5,
          provider: 'birdeye',
        },
      ],
    }
  );

  assert.equal(result.fetchedMints, 1);
  assert.equal(result.written, 3);
  assert.equal(result.historicalWritten, 1);
  assert.equal(result.estimatedWritten, 0);
  assert.equal(result.missingWritten, 2);
  assert.deepEqual(inserts[0][0], ['token-a', 'token-a', 'token-a']);
  assert.deepEqual(inserts[0][2], [0, 1.5, 0]);
  assert.deepEqual(inserts[0][5], ['missing', 'historical', 'missing']);
});

test('backfillHistoricalTokenPricesRange uses current fallback when range fetch fails', async () => {
  const inserts: any[][] = [];
  const db = {
    async query<T extends QueryResultRow = any>(text: string, params?: any[]): Promise<QueryResult<T>> {
      if (text.includes('SELECT mint, bucket, price_usd')) {
        return mockResult<T>([]);
      }
      if (text.includes('INSERT INTO token_price_snapshots')) {
        inserts.push(params ?? []);
        return mockResult<T>([]);
      }
      return mockResult<T>([]);
    },
  };

  const result = await backfillHistoricalTokenPricesRange(
    db,
    ['token-a'],
    new Date('2026-05-09T00:00:00Z'),
    new Date('2026-05-09T01:00:00Z'),
    {
      allowCurrentFallback: true,
      getCurrentPrices: async () => new Map([[
        'token-a',
        { priceUsd: 9, decimals: 6, quality: 'current' },
      ]]),
      fetchHistoricalPriceRange: async () => null,
    }
  );

  assert.equal(result.failedMints, 1);
  assert.equal(result.estimatedWritten, 2);
  assert.equal(result.written, 2);
  assert.deepEqual(inserts[0][2], [9, 9]);
  assert.deepEqual(inserts[0][5], ['estimated', 'estimated']);
});
