import assert from 'node:assert/strict';
import test from 'node:test';
import { payableInterest, projectLiveYield, settleRecordedGrowth, unsigned } from '../services/duskYieldAccounting';

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
        swapFeeGrowthRemainderScaled: '0',junior: { swapGrowthQ64: q64,interestGrowthQ64: q64*2n } } },
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


const q = 1n << 64n;
function market(cash = 100n) {
  const fees = { swapFeeGrowthIndexQ64: 0n,interestGrowthIndexQ64: 2n*q,unallocatedSwapFeeLiability: 0n,swapFeeGrowthRemainderScaled: 0n };
  const side = { assetMint: { equals: (other: unknown) => other === 'asset' },hlpMint: { equals: (other: unknown) => other === 'hlp' },
    fees,shares: { srlpSupply: 100n },reserves: { cashReserve: cash } };
  const vault = { srlpShares: 0n,hlpSupply: 10n,baseSwapFeeGrowthIndexQ64: 0n,baseSwapFeeCheckpointQ64: 0n,baseSwapFeeRemainderQ64: 0n,
    baseSwapFeeGrowthRemainderScaled: 0n,unallocatedBaseSwapFeeAmount: 0n,
    baseInterestGrowthIndexQ64: 3n*q,baseInterestGrowthRemainderScaled: 0n,unallocatedBaseInterestAmount: 0n };
  return { srlpMint: { equals: (other: unknown) => other === 'senior' },baseSide: side,
    quoteSide: { ...side,assetMint: { equals: () => false },hlpMint: { equals: () => false } },baseHlpVault: vault,quoteHlpVault: {} };
}
const holder = (lpMint: string, tokenKind: number) => ({ assetMint: 'asset',lpMint,tokenKind,swapFeeCheckpointQ64: 0n,
  interestCheckpointQ64: q,swapFeeRemainderQ64: 0n,interestRemainderQ64: 0n,accruedSwapFeeAmount: 0n,accruedInterestAmount: 1n });

test('credited srLP interest is the checkpointed amount plus the balance times the index change', () => {
  // Interest is credited at accrual: no receivable book, epoch or archive is read.
  assert.equal(projectLiveYield(market(),holder('senior',0),3n).interestAmount,4n);
  // A zero wallet keeps what was checkpointed before it emptied.
  assert.equal(projectLiveYield(market(),holder('senior',0),0n).interestAmount,1n);
});

test('hLP interest reads the vault index published at accrual, never the srLP interest index', () => {
  const state = market();
  assert.equal(projectLiveYield(state,holder('hlp',1),3n).interestAmount,7n);
  state.baseSide.fees.interestGrowthIndexQ64 = 50n*q;
  assert.equal(projectLiveYield(state,holder('hlp',1),3n).interestAmount,7n);
  // Interest credited while the vault had no supply waits as unallocated and
  // reaches the first holders through the index.
  Object.assign(state.baseHlpVault,{ unallocatedBaseInterestAmount: 20n });
  assert.equal(projectLiveYield(state,holder('hlp',1),3n).interestAmount,13n);
  Object.assign(state.baseHlpVault,{ hlpSupply: 0n });
  assert.equal(projectLiveYield(state,holder('hlp',1),3n).interestAmount,7n);
});

test('interest a frozen vault holds for its creditors is not hLP holder yield', () => {
  const state = market();
  Object.assign(state.baseHlpVault,{ heldBaseInterest: 1_000n,heldQuoteInterest: 1_000n });
  assert.equal(projectLiveYield(state,holder('hlp',1),3n).interestAmount,7n);
});

test('harvest pays credited interest from reserve cash and leaves the rest claimable', () => {
  assert.equal(payableInterest(market(100n),'base',4n),4n);
  assert.equal(payableInterest(market(3n),'base',4n),3n);
  assert.equal(payableInterest(market(0n),'base',4n),0n);
  assert.throws(() => payableInterest(market((1n << 64n)),'base',4n),/overflow/);
});
