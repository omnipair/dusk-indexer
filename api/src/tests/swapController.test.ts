import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSwapHistoryQuery,
  decodeSwapHistoryCursor,
  encodeSwapHistoryCursor,
  parseSwapHistoryRange,
} from '../controllers/swapController';

test('parseSwapHistoryRange accepts ISO dates and Unix timestamps', () => {
  const range = parseSwapHistoryRange({
    from: '2026-05-01T00:00:00Z',
    to: '1780272000000',
  });

  assert.equal(range.from, '2026-05-01T00:00:00.000Z');
  assert.equal(range.to, '2026-06-01T00:00:00.000Z');
});

test('parseSwapHistoryRange rejects reversed ranges', () => {
  assert.throws(
    () => parseSwapHistoryRange({
      from: '2026-06-01T00:00:00Z',
      to: '2026-05-01T00:00:00Z',
    }),
    /from must be earlier than to/,
  );
});

test('swap history cursor round-trips timestamp and id', () => {
  const cursor = {
    timestamp: '2026-05-12T12:30:00.000Z',
    id: 42,
  };

  assert.deepEqual(decodeSwapHistoryCursor(encodeSwapHistoryCursor(cursor)), cursor);
  assert.throws(() => decodeSwapHistoryCursor('not-a-cursor'), /cursor is invalid/);
});

test('buildSwapHistoryQuery applies a half-open time range', () => {
  const built = buildSwapHistoryQuery({
    pairAddress: 'pair-1',
    limit: 25,
    offset: 10,
    from: '2026-05-01T00:00:00.000Z',
    to: '2026-06-01T00:00:00.000Z',
  });

  assert.deepEqual(built.params, [
    'pair-1',
    '2026-05-01T00:00:00.000Z',
    '2026-06-01T00:00:00.000Z',
    26,
    10,
  ]);
  assert.match(built.query, /"timestamp" >= \$2::timestamptz/);
  assert.match(built.query, /"timestamp" < \$3::timestamptz/);
  assert.match(built.query, /ORDER BY "timestamp" DESC, id DESC/);
});

test('buildSwapHistoryQuery uses keyset pagination when a cursor is present', () => {
  const built = buildSwapHistoryQuery({
    pairAddress: 'pair-1',
    limit: 100,
    offset: 999,
    cursor: {
      timestamp: '2026-05-12T12:30:00.000Z',
      id: 42,
    },
  });

  assert.deepEqual(built.params, [
    'pair-1',
    '2026-05-12T12:30:00.000Z',
    42,
    101,
    0,
  ]);
  assert.match(built.query, /\("timestamp", id\) < \(\$2::timestamptz, \$3\)/);
});
