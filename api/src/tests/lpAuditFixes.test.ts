import test from 'node:test';
import assert from 'node:assert/strict';
import { QueryResult, QueryResultRow } from 'pg';
import { calculateCurrentLpTokenAmounts } from '../services/currentLpValuationService';
import { backfillLpEarnings } from '../services/lpEarningsBackfillService';
import {
  hasUnknownSameSlotOrdering,
  isBeforeEarningSource,
} from '../utils/eventOrdering';

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

test('calculateCurrentLpTokenAmounts values current LP share from live reserves', () => {
  const amounts = calculateCurrentLpTokenAmounts(
    2_500,
    10_000,
    1_000_000_000,
    2_000_000
  );

  assert.deepEqual(amounts, {
    token0Amount: 250_000_000,
    token1Amount: 500_000,
  });
});

test('same-slot ordering only treats proven prior events as before the earning source', () => {
  const source = { slot: 20, txSig: 'tx-a', instructionPath: '000003.000001' };

  assert.equal(isBeforeEarningSource(
    { slot: 19, txSig: 'tx-z', instructionPath: null },
    source
  ), true);
  assert.equal(isBeforeEarningSource(
    { slot: 20, txSig: 'tx-a', instructionPath: '000003.000000' },
    source
  ), true);
  assert.equal(isBeforeEarningSource(
    { slot: 20, txSig: 'tx-a', instructionPath: '000003.000002' },
    source
  ), false);
  assert.equal(isBeforeEarningSource(
    { slot: 20, txSig: 'tx-b', instructionPath: '000000.000000' },
    source
  ), false);
  assert.equal(hasUnknownSameSlotOrdering(
    { slot: 20, txSig: 'tx-b', instructionPath: '000000.000000' },
    source
  ), true);
});

test('backfillLpEarnings finalizes a source event only after transactional allocation', async () => {
  const statements: string[] = [];
  let sourceCompleted = false;

  const db = {
    async query<T extends QueryResultRow = any>(text: string, _params?: any[]): Promise<QueryResult<T>> {
      statements.push(text);

      if (text.includes('WITH event_rows')) {
        return mockResult<T>(sourceCompleted ? [] : [{
          source: 'swap_fee',
          source_event_id: '42',
          source_tx_sig: 'tx-source',
          pair: 'pair-a',
          event_slot: '20',
          event_timestamp: new Date('2026-05-09T00:00:00Z'),
          source_instruction_index: 3,
          source_instruction_path: '000003',
          token0_amount: '1000000',
          token1_amount: '0',
        }]);
      }

      if (text.includes('SELECT token0, token1 FROM pools')) {
        return mockResult<T>([{ token0: 'token-a', token1: 'token-b' }]);
      }

      if (text.includes('SELECT DISTINCT ON (signer)')) {
        return mockResult<T>([{ signer: 'lp-a', lp_amount: '5000' }]);
      }

      if (text.includes('1000 + COALESCE(SUM')) {
        return mockResult<T>([{ total_supply: '10000' }]);
      }

      if (text.includes('FROM token_price_snapshots')) {
        return mockResult<T>([
          {
            mint: 'token-a',
            bucket: new Date('2026-05-09T00:00:00Z'),
            price_usd: '1',
            decimals: 6,
            provider: 'birdeye',
            quality: 'historical',
          },
          {
            mint: 'token-b',
            bucket: new Date('2026-05-09T00:00:00Z'),
            price_usd: '1',
            decimals: 6,
            provider: 'birdeye',
            quality: 'historical',
          },
        ]);
      }

      if (text.includes('has_unknown_same_slot_ordering')) {
        return mockResult<T>([{ has_unknown_same_slot_ordering: false }]);
      }

      if (text.includes('INSERT INTO lp_earning_source_events')) {
        sourceCompleted = true;
      }

      return mockResult<T>([]);
    },
  };

  const result = await backfillLpEarnings(db, { maxEvents: 2 });
  const firstDiscovery = statements.find((statement) => statement.includes('WITH event_rows')) ?? '';

  assert.equal(result.scannedEvents, 1);
  assert.equal(result.allocatedRows, 1);
  assert.equal(firstDiscovery.includes('FROM lp_earning_source_events existing'), true);
  assert.equal(firstDiscovery.includes('FROM lp_position_earning_events existing'), false);
  assert.equal(statements.includes('BEGIN'), true);
  assert.equal(statements.includes('COMMIT'), true);
  assert.equal(sourceCompleted, true);
});
