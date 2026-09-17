import test from 'node:test';
import assert from 'node:assert/strict';
import { nadPrice, quoteHistorySelection } from '../services/duskQuoteHistory';
import { priceFixture } from './duskPriceFixtures';

const query = { market: priceFixture().source().market,side: 'base' as const,since: '2026-09-01T00:00:00Z',
  until: '2026-09-02T00:00:00Z',resolutionSeconds: 60,deploymentIdentitySha256: 'a'.repeat(64) };
test('native quote selection rejects changed sides, unbounded bars and invalid identity/time ranges',() => {
  assert.equal(quoteHistorySelection(query).since,'2026-09-01T00:00:00.000Z');
  for (const change of [
    { market: 'bad' },{ side: 'token0' },{ deploymentIdentitySha256: '' },{ resolutionSeconds: 1 },
    { resolutionSeconds: 60.5 },{ since: '2025-01-01T00:00:00Z' },{ since: query.until },
    { until: new Date(Date.now()+60_000).toISOString() },{ until: 'no' },
  ]) assert.throws(() => quoteHistorySelection({ ...query,...change } as typeof query),/selection/);
});
test('program quotes retain all nine NAD decimals and u64 precision without applying mint decimals again',() => {
  assert.equal(nadPrice('2500000000'),'2.5');
  assert.equal(nadPrice('1000000000'),'1');
  assert.equal(nadPrice('1'),'0.000000001');
  assert.equal(nadPrice('9007199254740993'),'9007199.254740993');
  assert.equal(nadPrice('18446744073709551615'),'18446744073.709551615');
  for (const value of ['0','-1','1.0','01','NaN','18446744073709551616']) assert.throws(() => nadPrice(value));
});
