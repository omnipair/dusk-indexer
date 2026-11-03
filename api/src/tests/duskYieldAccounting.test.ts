import assert from 'node:assert/strict';
import test from 'node:test';
import { projectLiveYield, settleRecordedGrowth, unsigned } from '../services/duskYieldAccounting';

test('yield checkpoints preserve sub-atom carry across transfers and claims', () => {
  const half = 1n << 63n;
  const first = settleRecordedGrowth({ balance: '3', index: half, checkpoint: '0', remainder: '0', accrued: '4' });
  assert.deepEqual(first, { amount: '5', remainder: half.toString() });
  // Balance falls to one after a transfer. The old holder keeps the first
  // interval and its fractional carry, even after claiming whole atoms.
  assert.deepEqual(settleRecordedGrowth({ balance: '1', index: half*2n, checkpoint: half, remainder: first.remainder, accrued: '0' }), { amount: '1', remainder: '0' });
});

test('jrLP uses its own growth ledger and includes burned exit escrow', () => {
  const q64 = 1n << 64n;
  const mint = { equals: (other: unknown) => other === 'junior' };
  const asset = { equals: (other: unknown) => other === 'asset' };
  const result = projectLiveYield({
    srlpMint: { equals: () => false },
    juniorMint: mint,
    baseSide: { assetMint: asset,hlpMint: { equals: () => false },shares: { srlpSupply: '100' },
      fees: { swapFeeGrowthIndexQ64: '0',interestGrowthIndexQ64: '0',unallocatedSwapFeeLiability: '0',
        unallocatedInterestLiability: '0',swapFeeGrowthRemainderScaled: '0',interestGrowthRemainderScaled: '0',
        junior: { swapGrowthQ64: q64,interestGrowthQ64: q64*2n } } },
    quoteSide: { assetMint: { equals: () => false },hlpMint: { equals: () => false },shares: { srlpSupply: '100' },
      fees: {} as any },
    baseHlpVault: {},quoteHlpVault: {},
  }, {
    assetMint: 'asset',lpMint: 'junior',tokenKind: 2,escrowBalance: '3',
    swapFeeCheckpointQ64: '0',interestCheckpointQ64: '0',swapFeeRemainderQ64: '0',interestRemainderQ64: '0',
    accruedSwapFeeAmount: '0',accruedInterestAmount: '0',
  }, 2n);
  assert.equal(result.swapFeeAmount,5n);
  assert.equal(result.interestAmount,10n);
});

test('native yield amounts remain exact beyond Number precision and fail closed', () => {
  const q64 = 1n << 64n;
  assert.equal(settleRecordedGrowth({ balance: '9007199254740993', index: q64, checkpoint: '0', remainder: '0', accrued: '0' }).amount, '9007199254740993');
  assert.throws(() => settleRecordedGrowth({ balance: '1', index: '0', checkpoint: '1', remainder: '0', accrued: '0' }), /regressed/);
  assert.throws(() => settleRecordedGrowth({ balance: '1', index: q64, checkpoint: '0', remainder: '0', accrued: ((1n<<64n)-1n).toString() }), /overflow/);
  assert.throws(() => unsigned(Number('9007199254740993')), /precision/);
  assert.throws(() => unsigned(1.5), /precision/);
});
