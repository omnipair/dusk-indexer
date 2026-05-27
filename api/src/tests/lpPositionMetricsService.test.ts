import test from 'node:test';
import assert from 'node:assert/strict';
import { QueryResult, QueryResultRow } from 'pg';
import {
  getLpPositionMetricKey,
  getLpPositionMetricsForRows,
} from '../services/lpPositionMetricsService';

function mockResult<T extends QueryResultRow = any>(rows: QueryResultRow[]): QueryResult<T> {
  return {
    rows: rows as T[],
    rowCount: rows.length,
    command: 'SELECT',
    oid: 0,
    fields: [],
  };
}

test('LP position metrics expose historical and current USD earnings values', async () => {
  const db = {
    async query<T extends QueryResultRow = any>(text: string): Promise<QueryResult<T>> {
      if (text.includes('FROM lp_position_earnings')) {
        return mockResult<T>([{
          pair: 'pair-a',
          signer: 'user-a',
          accrued_interest0: '1000000',
          accrued_interest1: '0',
          swap_fees0: '0',
          swap_fees1: '2000000',
          accrued_interest_usd: '1',
          swap_fees_usd: '9',
          total_earned_usd: '10',
          accrued_interest_price_quality: 'estimated',
          swap_fees_price_quality: 'historical',
          total_earned_price_quality: 'estimated',
        }]);
      }

      if (text.includes('FROM adjust_liquidity')) {
        return mockResult<T>([{
          pair: 'pair-a',
          signer: 'user-a',
          net_amount0: '1000000',
          net_amount1: '1000000',
        }]);
      }

      return mockResult<T>([]);
    },
  };

  const metrics = await getLpPositionMetricsForRows(
    db,
    [{
      signer: 'user-a',
      pair: 'pair-a',
      token0Mint: 'token-a',
      token1Mint: 'token-b',
      amount0: '3000000',
      amount1: '3000000',
      lpAmount: '100',
    }],
    {
      currentPrices: new Map([
        ['token-a', { priceUsd: 2, decimals: 6, quality: 'current' }],
        ['token-b', { priceUsd: 5, decimals: 6, quality: 'current' }],
      ]),
      currentAmountsByPosition: new Map([[
        getLpPositionMetricKey('user-a', 'pair-a'),
        {
          signer: 'user-a',
          pair: 'pair-a',
          token0Amount: 4_000_000,
          token1Amount: 1_000_000,
          exact: true,
        },
      ]]),
    }
  );

  const positionMetrics = metrics.get(getLpPositionMetricKey('user-a', 'pair-a'));
  assert.equal(positionMetrics?.earnings.totalEarned.usd, '10');
  assert.equal(positionMetrics?.earnings.totalEarned.historicalUsd, '10');
  assert.equal(positionMetrics?.earnings.totalEarned.currentUsd, '12');
  assert.equal(positionMetrics?.earnings.totalEarned.priceQuality, 'estimated');
  assert.equal(positionMetrics?.earnings.totalEarned.currentPriceQuality, 'current');
  assert.equal(positionMetrics?.earnings.totalEarned.priceBasis, 'historical');
  assert.equal(positionMetrics?.valueDelta.currentValue.usd, '13');
  assert.equal(positionMetrics?.valueDelta.currentValue.priceBasis, 'current');
});
