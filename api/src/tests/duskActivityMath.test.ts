import test from 'node:test';
import assert from 'node:assert/strict';
import { ActivityPriceBasis, parseActivityEvent, valueActivityAmounts } from '../services/duskActivityMath';
import { activityPayload, activityReceipt, activitySlot, activityTime } from './duskActivityFixtures';
import { priceFixture } from './duskPriceFixtures';
import { fixtureKey } from './duskYieldCheckpointFixtures';

function price(): ActivityPriceBasis {
  const fixture = priceFixture();
  return { capture: { id: '7',slot: activitySlot-1,blockTime: '2026-09-02T00:00:09Z' },
    bound: { baseMint: fixture.baseMint,quoteMint: fixture.quoteMint,baseDecimals: 9,quoteDecimals: 6 },
    prices: [ { mint: fixture.baseMint,decimals: 9,priceUsd: '2.5',quality: 'derived-reference' },
      { mint: fixture.quoteMint,decimals: 6,priceUsd: '1',quality: 'configured-reference' } ] };
}
const parse = (name = 'SwapExecuted',payload = activityPayload(name)) => parseActivityEvent(name,payload,String(activitySlot));
const value = (payload = activityPayload(),basis: ActivityPriceBasis | null = price()) =>
  valueActivityAmounts(parse('SwapExecuted',payload).amounts,basis,activitySlot,activityTime);

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
    assert.equal(valueActivityAmounts([interest],price(),activitySlot,activityTime)[0].usd,'0.25');
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

test('same-slot and future quotes cannot value an earlier trade; old prior-slot quotes can',() => {
  const captured = (changed: object) => ({ ...price(),capture: { ...price().capture!,...changed } });
  for (const changed of [{ slot: activitySlot },{ slot: activitySlot+1 },{ slot: -1 },
    { blockTime: '2026-09-02T00:00:11Z' },{ blockTime: 'invalid' }])
    assert.throws(() => value(undefined,captured(changed)),/event-time boundary/);
  assert.equal(value(undefined,captured({ blockTime: '2026-09-01T23:59:09Z' }))[0].usd,'5');
  assert.throws(() => valueActivityAmounts([],null,Number.MAX_SAFE_INTEGER+1,activityTime),/boundary/);
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

/** Devnet META/USDC (ogZU): both mints have six decimals and a configured $1
 * reference, and only USDC is a USD stablecoin. */
function stableMarket(capture: ActivityPriceBasis['capture'] = price().capture): ActivityPriceBasis {
  const fixture = priceFixture();
  return { capture,bound: { baseMint: fixture.baseMint,quoteMint: fixture.quoteMint,baseDecimals: 6,quoteDecimals: 6 },
    prices: [ { mint: fixture.baseMint,decimals: 6,priceUsd: '1',quality: 'configured-reference' },
      { mint: fixture.quoteMint,decimals: 6,priceUsd: '1',quality: 'configured-reference' } ],stablecoins: [fixture.quoteMint] };
}
/** ogZU's spot sale of 5,000 META for 4,552.392015 USDC. */
const spotSale = () => ({ ...activityPayload(),asset_in_side: '0',fee_asset_side: '0',amount_in: '5000000000',amount_out: '4552392015',
  gross_amount_out: '4552392015',amount_in_after_fee: '4986747516',base_fee: '12500000',divergence_fee: '565812',volatility_fee: '186672',
  retained_fee: '0',compounded_fee: '6626242' });
/** ogZU's leverage open: 912 USDC buys 902.29459 META. */
const leverageBuy = () => ({ ...activityPayload(),asset_in_side: '1',fee_asset_side: '1',amount_in: '912000000',amount_out: '902294590',
  gross_amount_out: '902294590',amount_in_after_fee: '909712799',base_fee: '2280000',divergence_fee: '7201',volatility_fee: '0',
  retained_fee: '0',compounded_fee: '1143600' });

test('a swap against a USD stablecoin is valued from that leg, not the other asset\'s configured price',() => {
  const sale = value(spotSale(),stableMarket());
  assert.deepEqual(sale.map(({ metric,amount,asset,usd }) => [metric,amount,asset,usd]),[
    ['volume','4552392015',{ side: 1 },'4552.392015'],['swapFees','13252484',{ side: 0 },'13.252484'],
    ['retainedFees','0',{ side: 0 },'0'],['compoundedFees','6626242',{ side: 0 },'6.626242']]);
  assert.equal(sale[0].priceCaptureId,'7');
  assert.equal(value(spotSale(),{ ...stableMarket(),stablecoins: [] })[0].usd,'5000');
  // Paying with the stablecoin is valued from the input, which is that leg.
  assert.equal(value(leverageBuy(),stableMarket())[0].usd,'912');
  // The curve output includes a fee charged in the stablecoin.
  const quoteFee = value({ ...spotSale(),fee_asset_side: '1',amount_in_after_fee: '5000000000',gross_amount_out: '4563773000',
    amount_out: '4552392020',base_fee: '11380980',divergence_fee: '0',volatility_fee: '0',compounded_fee: '5690490' },stableMarket());
  assert.deepEqual(quoteFee.slice(0,2).map(({ usd }) => usd),['4563.773','11.38098']);
});

test('an unpriced stablecoin leg leaves the trade to its input price; a stablecoin pair keeps the input',() => {
  const unpriced = stableMarket(); unpriced.prices = unpriced.prices.slice(0,1);
  assert.equal(value(spotSale(),unpriced)[0].usd,'5000');
  assert.equal(value(spotSale(),{ ...stableMarket(),stablecoins: [priceFixture().baseMint,priceFixture().quoteMint] })[0].usd,'5000');
  unpriced.prices = []; assert.equal(value(spotSale(),unpriced)[0].usd,null);
});

test('a leverage open that is the market\'s first swap is priced from its mints\' own references without a snapshot',() => {
  const first = stableMarket(null);
  const swap = valueActivityAmounts(parseActivityEvent('SwapExecuted',leverageBuy(),String(activitySlot),'canonical-swap-events').amounts,
    first,activitySlot,activityTime);
  assert.deepEqual(swap.map(({ metric,usd }) => [metric,usd]),
    [['volume','912'],['swapFees','2.287201'],['retainedFees','0'],['compoundedFees','1.1436']]);
  assert.ok(swap.every((entry) => entry.priceCaptureId === null));
  const opened = parseActivityEvent('LeveragePositionOpened',{ ...activityPayload('LeveragePositionOpened'),collateral_amount: '902294590' },
    String(activitySlot),'canonical-swap-events');
  assert.deepEqual(valueActivityAmounts(opened.amounts,first,activitySlot,activityTime).map(({ metric,usd,priceQuality }) => [metric,usd,priceQuality]),
    [['marginVolume','902.29459','configured-reference']]);
  // Without a snapshot there is no spot quote to derive a price from.
  assert.throws(() => valueActivityAmounts(opened.amounts,{ ...first,spotPrices: { base: '1',quote: '1' } },activitySlot,activityTime),/missing snapshot/);
  const derived = stableMarket(null); derived.prices[0].quality = 'derived-reference';
  assert.throws(() => valueActivityAmounts(opened.amounts,derived,activitySlot,activityTime),/missing snapshot/);
});

test('a quote cannot substitute mint decimals or price a foreign debt asset',() => {
  const wrongDecimals = price(); wrongDecimals.prices[0].decimals = 6;
  assert.throws(() => value(undefined,wrongDecimals),/decimals/);
  const wrongMint = parse('MarketDebtUpdated',{ ...activityPayload('MarketDebtUpdated'),debt_asset_mint: fixtureKey(1).toBase58() });
  assert.throws(() => valueActivityAmounts(wrongMint.amounts,price(),activitySlot,activityTime),/outside its market/);
  for (const amount of ['0','-1','NaN','Infinity']) {
    const invalid = price(); invalid.prices[0].priceUsd = amount;
    assert.throws(() => value(undefined,invalid));
  }
});
