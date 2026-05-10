import test from 'node:test';
import assert from 'node:assert/strict';
import { QueryResult, QueryResultRow } from 'pg';
import {
  computePortfolioSnapshotValues,
  reconstructDebtFromPrincipal,
} from '../services/portfolioSnapshotService';

function queryResult<T extends QueryResultRow>(rows: T[]): QueryResult<T> {
  return {
    rows,
    rowCount: rows.length,
    command: 'SELECT',
    oid: 0,
    fields: [],
  };
}

function mockResult<T extends QueryResultRow = any>(rows: QueryResultRow[]): QueryResult<T> {
  return queryResult(rows as T[]);
}

test('historical portfolio snapshots value debt from adjust debt principal, not raw debt shares', async () => {
  const bucket = new Date('2026-02-22T07:00:00Z');
  const statements: string[] = [];

  const db = {
    async query<T extends QueryResultRow = any>(text: string, _params?: any[]): Promise<QueryResult<T>> {
      statements.push(text);

      if (text.includes('FROM user_lp_position_updated_events')) {
        return mockResult<T>([]);
      }

      if (text.includes('FROM user_position_updated_events')) {
        return mockResult<T>([
          {
            pair: 'pair-a',
            position: 'position-a',
            collateral0: '0',
            collateral1: '0',
            debt0_shares: '0',
            debt1_shares: '287007246802295',
            token0: 'token-a',
            token1: 'token-b',
          },
        ]);
      }

      if (text.includes('FROM token_price_snapshots')) {
        return mockResult<T>([
          {
            mint: 'token-a',
            bucket,
            price_usd: '1',
            decimals: 6,
            provider: 'birdeye',
            quality: 'historical',
          },
          {
            mint: 'token-b',
            bucket,
            price_usd: '1',
            decimals: 6,
            provider: 'birdeye',
            quality: 'historical',
          },
        ]);
      }

      if (text.includes('FROM adjust_debt_events')) {
        return mockResult<T>([
          {
            pair: 'pair-a',
            debt0: '0',
            debt1: '287051770',
          },
        ]);
      }

      return mockResult<T>([]);
    },
  };

  const values = await computePortfolioSnapshotValues(db, 'user-a', bucket, {
    historical: true,
    dryRun: true,
  });

  assert.equal(values.quality, 'estimated');
  assert.equal(values.debtValueUsd, 287.05177);
  assert.equal(values.netValueUsd, -287.05177);
  assert.equal(statements.some((statement) => statement.includes('FROM adjust_debt_events')), true);
});

test('reconstructDebtFromPrincipal never values raw debt shares as token debt', () => {
  const debt = reconstructDebtFromPrincipal(
    {
      pair: 'pair-a',
      debt0_shares: '0',
      debt1_shares: '287007246802295',
    },
    new Map([
      [
        'pair-a',
        {
          debt0: 0,
          debt1: 287051770,
          exact: false,
        },
      ],
    ])
  );

  assert.deepEqual(debt, {
    debt0: 0,
    debt1: 287051770,
    exact: false,
  });
});
