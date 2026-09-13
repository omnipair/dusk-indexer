import test from 'node:test';
import assert from 'node:assert/strict';
import { eventHistorySelection } from '../services/duskEventHistory';

test('history selection rejects malformed ranges, addresses and cursors', () => {
  const query = { until: '2026-09-01T00:00:00Z', limit: 100, deploymentIdentitySha256: 'a'.repeat(64) };
  assert.equal(eventHistorySelection(query).window.market,null);
  for (const patch of [{limit:0},{limit:501},{limit:1.5},{market:'not-a-key'},{since:'2026-09-02T00:00:00Z'},
    {until:'bad'},{cursor:'bad'},{cursor:'A'.repeat(1025)},{deploymentIdentitySha256:'x'}])
    assert.throws(() => eventHistorySelection({...query,...patch}),/query or cursor/);
});
