import assert from 'node:assert/strict';
import test from 'node:test';
import { settleRecordedGrowth, unsigned } from '../services/duskYieldAccounting';

test('yield checkpoints preserve sub-atom carry across transfers and claims', () => {
  const half = 1n << 63n;
  const first = settleRecordedGrowth({ balance: '3', index: half, checkpoint: '0', remainder: '0', accrued: '4' });
  assert.deepEqual(first, { amount: '5', remainder: half.toString() });
  // Balance falls to one after a transfer. The old holder keeps the first
  // interval and its fractional carry, even after claiming whole atoms.
  assert.deepEqual(settleRecordedGrowth({ balance: '1', index: half*2n, checkpoint: half, remainder: first.remainder, accrued: '0' }), { amount: '1', remainder: '0' });
});

test('native yield amounts remain exact beyond Number precision and fail closed', () => {
  const q64 = 1n << 64n;
  assert.equal(settleRecordedGrowth({ balance: '9007199254740993', index: q64, checkpoint: '0', remainder: '0', accrued: '0' }).amount, '9007199254740993');
  assert.throws(() => settleRecordedGrowth({ balance: '1', index: '0', checkpoint: '1', remainder: '0', accrued: '0' }), /regressed/);
  assert.throws(() => settleRecordedGrowth({ balance: '1', index: q64, checkpoint: '0', remainder: '0', accrued: ((1n<<64n)-1n).toString() }), /overflow/);
  assert.throws(() => unsigned(Number('9007199254740993')), /precision/);
  assert.throws(() => unsigned(1.5), /precision/);
});
