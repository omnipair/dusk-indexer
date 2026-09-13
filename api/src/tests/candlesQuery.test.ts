import test from 'node:test';
import assert from 'node:assert/strict';

import { buildCandlesQuery } from '../controllers/swapController';

const sql = buildCandlesQuery().replace(/\s+/g, ' ');

test('the carry-forward is seeded with the last close before the window', () => {
  // Without a seed, a market that has not traded inside [from, to) yields no
  // candles at all: locf only knows about rows in the window, every bucket is
  // NULL, and the chart reports no history for a price that is perfectly
  // well known. The seed is the most recent priced swap strictly before from.
  assert.match(sql, /locf\( last\(price, timestamp\), prev := \( SELECT/);
  assert.match(sql, /prev := \( SELECT reserve1::numeric \/ NULLIF\(reserve0::numeric, 0\) FROM swaps WHERE pair = \$2 AND timestamp < to_timestamp\(\$3::bigint\)/);
  assert.match(sql, /ORDER BY timestamp DESC LIMIT 1 \)/);
});

test('the seed uses the same price definition as the window', () => {
  // Two different formulas for "price" would put a step at the window edge.
  const priceExpr = 'reserve1::numeric / NULLIF(reserve0::numeric, 0)';
  assert.equal(sql.split(priceExpr).length - 1, 2);
});

test('buckets are still trimmed only when nothing precedes them', () => {
  assert.match(sql, /trimmed AS \( SELECT \* FROM filled WHERE filled_close IS NOT NULL \)/);
});
