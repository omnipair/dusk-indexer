import assert from 'node:assert/strict';
import test from 'node:test';
import { projectRecordedYield } from '../services/duskYieldCheckpointMath';
import { checkpointFixture, fixtureKey, Q64 } from './duskYieldCheckpointFixtures';

test('recorded yLP growth preserves prior entitlement and fractional carry', () => {
  const result = projectRecordedYield(checkpointFixture());
  assert.equal(result.swapFeeAmount,'11');
  assert.equal(result.interestAmount,'10');
  assert.equal(result.totalAmount,'21');
  assert.equal(result.swapRemainderQ64,(Q64/2n).toString());
  assert.equal(result.basis,'recorded-growth.v1');
});

test('hLP uses its own vault and revenue-asset indexes instead of yLP growth', () => {
  for (const lpSide of ['base','quote'] as const) {
    const base = projectRecordedYield(checkpointFixture({ kind: 1,lpSide,revenue: 'base' }));
    const quote = projectRecordedYield(checkpointFixture({ kind: 1,lpSide,revenue: 'quote' }));
    assert.equal(base.swapFeeAmount,'14');
    assert.equal(quote.swapFeeAmount,'17');
    assert.equal(base.interestAmount,'7');
    assert.equal(base.assetDecimals,9);
    assert.equal(quote.assetDecimals,6);
  }
});

test('a zero canonical balance retains previously earned amounts and fractional carry', () => {
  const result = projectRecordedYield({ ...checkpointFixture(),lpBalance: '0' });
  assert.equal(result.swapFeeAmount,'5');
  assert.equal(result.interestAmount,'7');
  assert.equal(result.swapRemainderQ64,(Q64/2n).toString());
});

test('wrong owner, noncanonical token account and regressed growth fail instead of manufacturing earnings', () => {
  const fixture = checkpointFixture();
  assert.throws(() => projectRecordedYield({ ...fixture,lpTokenAccount: fixtureKey(120).toBase58() }),/canonical/);
  assert.throws(() => projectRecordedYield({ ...fixture,yield: { ...fixture.yield,owner: fixtureKey(121) } }),/canonical|PDA/);
  assert.throws(() => projectRecordedYield({ ...fixture,yield: { ...fixture.yield,swap_fee_checkpoint_q64: (10n*Q64).toString() } }),/regressed/);
  assert.throws(() => projectRecordedYield({ ...fixture,lpBalance: '18446744073709551616' }),/overflow/);
});
