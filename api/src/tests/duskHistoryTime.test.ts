import test from 'node:test';
import assert from 'node:assert/strict';
import { HISTORY_CLOCK_SKEW_MS, validHistoryUntil } from '../services/duskHistoryTime';
import { eventHistorySelection } from '../services/duskEventHistory';
import { orderHistorySelection } from '../services/duskOrderHistory';
import { quoteHistorySelection } from '../services/duskQuoteHistory';

test('bounded clock skew preserves event and order cursor identity as time advances', () => {
  const original = Date.now, now = Date.parse('2026-10-26T00:00:00Z');
  Date.now = () => now;
  try {
    const until = new Date(now + 100).toISOString(), owner = 'So11111111111111111111111111111111111111112';
    const query = { until, limit: 10, deploymentIdentitySha256: 'a'.repeat(64) };
    const event = eventHistorySelection(query), order = orderHistorySelection({...query,owner});
    const cursor = Buffer.from(JSON.stringify({scope:event.scope,watermark:'10',slot:String(event.pin.historyFirstSlot+1),
      key:[...event.identity,'2'.repeat(88),'0.1','0'].join('|')})).toString('base64url');
    const orderCursor = Buffer.from(JSON.stringify({scope:order.scope,watermark:'10',slot:String(order.pin.historyFirstSlot+1),
      key:[...order.identity,'2'.repeat(88),'0.1'].join('|')})).toString('base64url');
    Date.now = () => now + 5_000;
    assert.equal(eventHistorySelection({...query,cursor}).scope,event.scope);
    assert.equal(orderHistorySelection({...query,owner,cursor:orderCursor}).scope,order.scope);
    assert.equal(event.window.until,until);
    Date.now = () => now;
    const future = new Date(now+HISTORY_CLOCK_SKEW_MS+1).toISOString();
    assert.throws(() => eventHistorySelection({...query,until:future}));
    assert.throws(() => orderHistorySelection({...query,owner,until:future}));
    const quotes = { ...query,market:owner,side:'base' as const,since:new Date(now-60_000).toISOString(),resolutionSeconds:60 };
    assert.equal(quoteHistorySelection(quotes).until,until);
    assert.throws(() => quoteHistorySelection({...quotes,until:future}));
  } finally { Date.now = original; }
});

test('history clock allowance excludes malformed, negative and far-future cutoffs', () => {
  assert.equal(validHistoryUntil(1100,1000),true);
  assert.equal(validHistoryUntil(2000,1000),true);
  for (const value of [2001,-1,NaN,Infinity]) assert.equal(validHistoryUntil(value,1000),false);
});
