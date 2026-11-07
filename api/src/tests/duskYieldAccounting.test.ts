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
  const growth = () => ({ unitsQ64: 0n, weightedPaidQ128: [0n,0n,0n,0n] });
  const claims = Array.from({length:2},()=>({epoch:0n,unitsQ64:0n,paidCheckpointQ64:0n,growthCheckpoint:growth(),paidFractionQ128:0n,claimable:0n}));
  const result = projectLiveYield({
    income:{books:Array.from({length:4},()=>({epoch:0n,unpaid:0n,units:0n,paidPerUnitQ64:0n,growth:Array.from({length:4},growth)})),
      juniorEnd:Array.from({length:4},()=>({ended:false,epoch:0n,growth:growth()}))},
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
    assetMint: 'asset',lpMint: 'junior',tokenKind: 2,escrowBalance: '3',incomeInitialized:false,income:claims,
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


test('paid historical income survives a zero wallet balance and archived denominations', () => {
  const q = 1n << 64n;
  const growth = () => ({ unitsQ64: 0n, weightedPaidQ128: [0n,0n,0n,0n] });
  const claim = () => ({ epoch: 0n, unitsQ64: 0n, paidCheckpointQ64: 0n, growthCheckpoint: growth(), paidFractionQ128: 0n, claimable: 0n });
  const book = () => ({ epoch: 0n, unpaid: 0n, units: 0n, paidPerUnitQ64: 0n, growth: [growth(),growth(),growth(),growth()] });
  const books = [book(),book(),book(),book()];
  books[0] = { ...book(), units: 10n, unpaid: 5n, paidPerUnitQ64: q/2n };
  const fees = { swapFeeGrowthIndexQ64: 0n,interestGrowthIndexQ64: 0n,unallocatedSwapFeeLiability: 0n,
    unallocatedInterestLiability: 0n,swapFeeGrowthRemainderScaled: 0n,interestGrowthRemainderScaled: 0n };
  const side = { assetMint: { equals: (other: unknown) => other === 'asset' }, hlpMint: {equals:()=>false},fees,shares:{srlpSupply:100n} };
  const market = {srlpMint:{equals:()=>true},baseSide:side,quoteSide:{...side,assetMint:{equals:()=>false}},
    baseHlpVault:{},quoteHlpVault:{},income:{books,juniorEnd:Array.from({length:4},()=>({ended:false,epoch:0n,growth:growth()}))}};
  const account = {assetMint:'asset',lpMint:'senior',tokenKind:0,swapFeeCheckpointQ64:0n,interestCheckpointQ64:0n,
    swapFeeRemainderQ64:0n,interestRemainderQ64:0n,accruedSwapFeeAmount:0n,accruedInterestAmount:1n,
    incomeInitialized:true,income:[{...claim(),unitsQ64:10n*q},claim()]};
  assert.equal(projectLiveYield(market,account,0n).interestAmount,6n);
  const archive = books[0];
  books[0] = {...book(),epoch:1n,units:5n,paidPerUnitQ64:q};
  assert.throws(()=>projectLiveYield(market,account,0n),/IncomeHistoryRequired/);
  assert.equal(projectLiveYield(market,account,0n,undefined,{archives:new Map([['0:0',archive]])}).interestAmount,11n);
});
