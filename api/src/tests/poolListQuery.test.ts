import test from 'node:test';
import assert from 'node:assert/strict';

import { buildPoolListQuery } from '../controllers/poolController';

const collapse = (sql: string) => sql.replace(/\s+/g, ' ').trim();

test('the pool list collapses duplicate rows for one market', () => {
  // The devnet database holds three rows per market because the UNIQUE on
  // pair_address was never applied there. Without this the markets page
  // renders each market once per duplicate row.
  const sql = collapse(buildPoolListQuery(false));

  assert.match(sql, /SELECT DISTINCT ON \(pair_address\)/);
  // DISTINCT ON keeps the first row of each group, so the group's order
  // decides which duplicate survives; by id it is the same one every time.
  assert.match(sql, /ORDER BY pair_address ASC, id ASC/);
});

test('the list still comes back in id order', () => {
  // DISTINCT ON forces its own leading ORDER BY, so the id ordering the
  // clients already depend on has to be reapplied outside it.
  const sql = collapse(buildPoolListQuery(false));

  assert.ok(
    sql.endsWith('ORDER BY id ASC'),
    `expected the outer query to order by id, got: ${sql}`,
  );
});

test('visibility filtering is unchanged', () => {
  assert.match(collapse(buildPoolListQuery(false)), /WHERE visible = TRUE/);
  assert.doesNotMatch(collapse(buildPoolListQuery(true)), /WHERE visible/);
});
