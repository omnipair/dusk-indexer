import test from 'node:test';
import assert from 'node:assert/strict';
import { eventHistorySelection } from '../services/duskEventHistory';

test('v2 includes native hLP and yield receipts without changing v1 cursor scope', () => {
  const query = { until: '2026-09-01T00:00:00Z', limit: 100, deploymentIdentitySha256: 'a'.repeat(64) };
  const original = eventHistorySelection(query), extended = eventHistorySelection({...query,version:2});
  assert.equal(eventHistorySelection({...query,version:1}).scope,original.scope);
  assert.notEqual(extended.scope,original.scope);
  assert.deepEqual(extended.supportedEvents.slice(-3),['HlpOpened','HlpClosed','YieldClaimed']);
  assert.equal(original.supportedEvents.length,11);
  const cursor = Buffer.from(JSON.stringify({scope:original.scope,watermark:'10',slot:String(original.pin.historyFirstSlot+1),
    key:[...original.identity,'2'.repeat(88),'0.1','0'].join('|')})).toString('base64url');
  assert.throws(() => eventHistorySelection({...query,version:2,cursor}),/query or cursor/);
  assert.throws(() => eventHistorySelection({...query,version:3 as 2}),/query or cursor/);
});

test('history selection rejects malformed ranges, addresses and cursors', () => {
  const query = { until: '2026-09-01T00:00:00Z', limit: 100, deploymentIdentitySha256: 'a'.repeat(64) };
  assert.equal(eventHistorySelection(query).window.market,null);
  for (const patch of [{limit:0},{limit:501},{limit:1.5},{market:'not-a-key'},{since:'2026-09-02T00:00:00Z'},
    {owner:'not-a-key',category:'leverage-close' as const},{owner:'So11111111111111111111111111111111111111112'},{category:'leverage-close' as const},{until:'bad'},{cursor:'bad'},{cursor:'A'.repeat(2049)},{deploymentIdentitySha256:'x'}])
    assert.throws(() => eventHistorySelection({...query,...patch}),/query or cursor/);
});

test('history cursors accept canonical CPI keys and reject substituted provenance', () => {
  const query = { until: '2026-09-01T00:00:00Z', limit: 2, deploymentIdentitySha256: 'a'.repeat(64) };
  const selection = eventHistorySelection(query);
  const key = [...selection.identity, '2'.repeat(88), '4.3', '0'].join('|');
  const cursor = { scope: selection.scope, watermark: '10', slot: String(selection.pin.historyFirstSlot + 1), key };
  const encode = (value: typeof cursor) => Buffer.from(JSON.stringify(value)).toString('base64url');
  assert.equal(eventHistorySelection({ ...query, cursor: encode(cursor) }).cursor?.key, key);
  for (const index of [0, 1, 2, 3]) {
    const parts = key.split('|');
    parts[index] += '1';
    assert.throws(() => eventHistorySelection({ ...query, cursor: encode({ ...cursor, key: parts.join('|') }) }), /query or cursor/);
  }
  for (const suffix of ['bad|4.3|0', `${'2'.repeat(88)}|4..3|0`, `${'2'.repeat(88)}|65536|0`, `${'2'.repeat(88)}|4.3|65536`])
    assert.throws(() => eventHistorySelection({ ...query, cursor: encode({ ...cursor, key: [...selection.identity, suffix].join('|') }) }), /query or cursor/);
  assert.throws(() => eventHistorySelection({ ...query, cursor: encode({ ...cursor, key: 'a'.repeat(64) }) }), /query or cursor/);
  const longest = [...selection.identity, '2'.repeat(88), Array(64).fill('65535').join('.'), '65535'].join('|');
  assert.equal(eventHistorySelection({ ...query, cursor: encode({ ...cursor, key: longest }) }).cursor?.key, longest);
});
