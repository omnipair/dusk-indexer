import test from 'node:test';
import assert from 'node:assert/strict';
import { governanceSelection } from '../services/duskGovernance';

test('governance selection takes one canonical market or none',() => {
  assert.equal(governanceSelection(undefined),null);
  const market = '11111111111111111111111111111111';
  assert.equal(governanceSelection(market),market);
  for (const value of ['',['a','b'],'not-a-key','1111111111111111111111111111111O',{}])
    assert.throws(() => governanceSelection(value),(error: Error & { status?: number }) => error.status === 400);
});
