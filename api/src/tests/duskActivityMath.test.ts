import test from 'node:test';
import assert from 'node:assert/strict';
import { ActivityPriceBasis, parseActivityEvent, valueActivityAmounts } from '../services/duskActivityMath';
import { activityPayload, activityReceipt, activitySlot, activityTime } from './duskActivityFixtures';
import { priceFixture } from './duskPriceFixtures';
import { fixtureKey } from './duskYieldCheckpointFixtures';

function price(): ActivityPriceBasis {
  const fixture = priceFixture();
  return { captureId: '7',slot: activitySlot-1,blockTime: '2026-09-02T00:00:09Z',
    bound: { baseMint: fixture.baseMint,quoteMint: fixture.quoteMint,baseDecimals: 9,quoteDecimals: 6 },
    prices: [ { mint: fixture.baseMint,decimals: 9,priceUsd: '2.5',quality: 'derived-reference' },
      { mint: fixture.quoteMint,decimals: 6,priceUsd: '1',quality: 'configured-reference' } ] };
}
const parse = (name = 'SwapExecuted',payload = activityPayload(name)) => parseActivityEvent(name,payload,String(activitySlot));
const value = (payload = activityPayload(),basis: ActivityPriceBasis | null = price()) =>
  valueActivityAmounts(parse('SwapExecuted',payload).amounts,basis,activitySlot,activityTime,60);

test('trade volume uses the input asset once, while fee components use the actual fee asset',() => {
  const values = value();
  assert.deepEqual(values.map(({ metric,usd }) => [metric,usd]),
    [['volume','5'],['swapFees','0.13'],['retainedFees','0.01'],['compoundedFees','0.05']]);
  const reverse = value({ ...activityPayload(),asset_in_side: '1',amount_in: '2000000',amount_in_after_fee: '1980000',fee_asset_side: '0' });
  assert.equal(reverse[0].usd,'2');
  assert.equal(reverse[1].usd,'0.000325');
  assert.equal(values[0].priceCaptureId,'7');
});

test('all leverage actions count their embedded receipt; a margin-only update has no trade',() => {
  for (const name of ['LeveragePositionOpened','LeveragePositionUpdated','LeveragePositionClosed','LeveragePositionLiquidated']) {
    const parsed = parse(name);
    assert.equal(parsed.hasSwap,true);
    assert.equal(parsed.amounts.filter((entry) => entry.metric === 'volume').length,1);
    assert.equal(parsed.amounts.find((entry) => entry.metric === 'swapFees')?.amount,'130000');
  }
  assert.deepEqual(parse('LeveragePositionUpdated',{ ...activityPayload('LeveragePositionUpdated'),swap: null,borrowed_amount: '0' }).amounts,[]);
  for (const name of ['LeveragePositionOpened','LeveragePositionClosed','LeveragePositionLiquidated'])
    assert.throws(() => parse(name,{ ...activityPayload(name),swap: null }),/payload/);
});

test('reported interest uses the debt mint, and hLP interest uses the funding side opposite its target',() => {
  for (const name of ['MarketDebtUpdated','LeveragePositionClosed','LeveragePositionLiquidated']) {
    const interest = parse(name).amounts.find((entry) => entry.metric === 'reportedInterest')!;
    assert.deepEqual(interest.asset,{ mint: priceFixture().quoteMint });
    assert.equal(valueActivityAmounts([interest],price(),activitySlot,activityTime,60)[0].usd,'0.25');
  }
  assert.equal(parse('MarketDebtUpdated').hasSwap,false);
  for (const name of ['HlpClosed','HlpTerminalLiquidated']) {
    assert.deepEqual(parse(name).amounts[0].asset,{ side: 1 });
    assert.deepEqual(parse(name,{ ...activityPayload(name),asset_side: '1',target_asset: '1' }).amounts[0].asset,{ side: 0 });
  }
  for (const name of ['YieldClaimed','ReferralInterestAccrued','FeeAuctionSettled','MarketCreated'])
    assert.throws(() => parse(name),/Unsupported/);
});

test('missing prices stay unknown; zero fee amounts remain known zero without a price',() => {
  const values = value(undefined,null);
  assert.ok(values.every((entry) => entry.usd === null));
  const incomplete = price(); incomplete.prices = incomplete.prices.slice(1);
  assert.equal(value(undefined,incomplete)[0].usd,null);
  assert.equal(value(undefined,incomplete)[1].usd,'0.13');
  const zero = value({ ...activityPayload(),base_fee: '0',divergence_fee: '0',volatility_fee: '0',retained_fee: '0',compounded_fee: '0' },null);
  assert.equal(zero[0].usd,null);
  assert.ok(zero.slice(1).every((entry) => entry.usd === '0' && entry.priceCaptureId === null));
});

test('same-slot, future-slot, future-time and stale quotes cannot value an earlier trade',() => {
  for (const changed of [{ slot: activitySlot },{ slot: activitySlot+1 },{ slot: -1 },
    { blockTime: '2026-09-02T00:00:11Z' },{ blockTime: '2026-09-01T23:59:09Z' },{ blockTime: 'invalid' }])
    assert.throws(() => value(undefined,{ ...price(),...changed }),/event-time boundary/);
  assert.equal(value(undefined,{ ...price(),blockTime: '2026-09-01T23:59:10Z' })[0].usd,'5');
  for (const age of [0,1.5,86401]) assert.throws(() => valueActivityAmounts([],null,activitySlot,activityTime,age),/boundary/);
  assert.throws(() => valueActivityAmounts([],null,Number.MAX_SAFE_INTEGER+1,activityTime,60),/boundary/);
});

test('exact u64 trade quantities are not rounded through JavaScript numbers',() => {
  const maximum = '18446744073709551615';
  assert.equal(value({ ...activityPayload(),amount_in: maximum,amount_in_after_fee: maximum })[0].usd,'46116860184.2738790375');
  const precise = price(); precise.prices[0].priceUsd = '0.000000000000000000000000001';
  assert.equal(value({ ...activityPayload(),amount_in: '1',amount_in_after_fee: '1' },precise)[0].usd,'0.000000000000000000000000000000000001');
});

test('malformed amounts, inconsistent fee partitions and mismatched metadata are rejected',() => {
  for (const amount of [1,'01','-1','1.5','1e6','18446744073709551616',null])
    assert.throws(() => parse('SwapExecuted',{ ...activityPayload(),amount_in: amount }),/u64/);
  for (const fields of [{ amount_in: '0' },{ amount_out: '5000001' },{ amount_in_after_fee: '2000000001' },
    { retained_fee: '30001' },{ compounded_fee: '120001' },{ base_fee: '18446744073709551615' }])
    assert.throws(() => parse('SwapExecuted',{ ...activityPayload(),...fields }),/Inconsistent/);
  for (const side of [0,2,'2','00']) assert.throws(() => parse('SwapExecuted',{ ...activityPayload(),fee_asset_side: side }),/side/);
  assert.throws(() => parse('LeveragePositionOpened',{ ...activityPayload('LeveragePositionOpened'),
    swap: { ...activityReceipt(),claimable_fee_credit: '70001' } }),/exceeds/);
  assert.throws(() => parse('MarketDebtUpdated',{ ...activityPayload('MarketDebtUpdated'),metadata: {
    market: fixtureKey(1).toBase58(),slot: String(activitySlot),signer: fixtureKey(2).toBase58() } }),/metadata/);
  assert.throws(() => parseActivityEvent('LeveragePositionOpened',activityPayload('LeveragePositionOpened'),String(activitySlot+1)),/metadata/);
});

test('a quote cannot substitute mint decimals or price a foreign debt asset',() => {
  const wrongDecimals = price(); wrongDecimals.prices[0].decimals = 6;
  assert.throws(() => value(undefined,wrongDecimals),/decimals/);
  const wrongMint = parse('MarketDebtUpdated',{ ...activityPayload('MarketDebtUpdated'),debt_asset_mint: fixtureKey(1).toBase58() });
  assert.throws(() => valueActivityAmounts(wrongMint.amounts,price(),activitySlot,activityTime,60),/outside its market/);
  for (const amount of ['0','-1','NaN','Infinity']) {
    const invalid = price(); invalid.prices[0].priceUsd = amount;
    assert.throws(() => value(undefined,invalid));
  }
});
