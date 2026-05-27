import test from 'node:test';
import assert from 'node:assert/strict';
import { QueryResult, QueryResultRow } from 'pg';
import { repairLpEarningsValuations } from '../services/lpValuationRepairService';

function mockResult<T extends QueryResultRow = any>(rows: QueryResultRow[]): QueryResult<T> {
  return {
    rows: rows as T[],
    rowCount: rows.length,
    command: 'SELECT',
    oid: 0,
    fields: [],
  };
}

test('LP valuation repair dry-run backfills prices but does not mutate earnings rows', async () => {
  const statements: string[] = [];
  const db = {
    async query<T extends QueryResultRow = any>(text: string, params?: any[]): Promise<QueryResult<T>> {
      statements.push(text);

      if (text.includes('SELECT MIN(date_trunc')) {
        return mockResult<T>([{ from_bucket: new Date('2026-05-09T00:00:00Z') }]);
      }

      if (text.includes('affected_mints')) {
        return mockResult<T>([{ mint: 'token-a' }]);
      }

      if (text.includes('SELECT mint, bucket, price_usd')) {
        return mockResult<T>([]);
      }

      if (text.includes('COUNT(*)::integer AS candidate_events')) {
        return mockResult<T>([{
          candidate_events: 3,
          affected_positions: 2,
          affected_users: 1,
        }]);
      }

      if (text.includes('INSERT INTO token_price_snapshots')) {
        assert.fail('dry-run should not persist token prices');
      }

      if (text.includes('UPDATE lp_position_earning_events')) {
        assert.fail('dry-run should not update earning events');
      }

      return mockResult<T>([]);
    },
  };

  const result = await repairLpEarningsValuations(db, {
    dryRun: true,
    priceBackfillOptions: {
      getCurrentPrices: async () => new Map([[
        'token-a',
        { priceUsd: 1, decimals: 6, quality: 'current' },
      ]]),
      fetchHistoricalPriceRange: async () => [],
    },
  });

  assert.equal(result.repricedEvents, 3);
  assert.equal(result.affectedPositions, 2);
  assert.equal(result.affectedUsers, 1);
  assert.equal(statements.some((statement) => statement.includes('COUNT(*)::integer AS candidate_events')), true);
});
