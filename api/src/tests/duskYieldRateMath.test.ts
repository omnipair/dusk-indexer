import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPinnedProtocol } from '../config/duskProtocol';
import { nativeFields } from '../services/duskPortfolioMath';
import { marketGrowthPoint, MarketGrowthPoint, recordedYlpRates } from '../services/duskYieldRateMath';
import { checkpointFixture, Q64 } from './duskYieldCheckpointFixtures';

function window() {
  const fixture = checkpointFixture(),market = fixture.market,marketAddress = fixture.source().market;
  market.version = 1;
  for (const [name,reserve] of [['base','100000000000'],['quote','100000000']] as const) {
    const side = nativeFields(market[`${name}_side`]);
    nativeFields(side.reserves).live_reserve = reserve;
    nativeFields(side.shares).ylp_supply = '1000000';
  }
  const point = (slot: number,blockTime: string) => marketGrowthPoint({ pin: loadPinnedProtocol(),marketAddress,
    market,slot,blockTime,deploymentIdentitySha256: '1'.repeat(64) });
  const start = point(900000001,'2026-09-01T00:00:00Z');
  const end = structuredClone(start);
  Object.assign(end,{ slot: start.slot+200000,blockTime: '2026-09-02T00:00:00Z',supply: '2000000' });
  end.assets[0].swapIndexQ64 = (BigInt(start.assets[0].swapIndexQ64)+Q64).toString();
  end.assets[1].interestIndexQ64 = (BigInt(start.assets[1].interestIndexQ64)+Q64/2n).toString();
  const prices = start.assets.map(({mint,decimals}) => ({mint,decimals,priceUsd: '1',quality: 'configured-reference'}));
  return {fixture,point,start,end,prices};
}

test('native share-growth earnings use raw share supply, unequal asset precision and elapsed time',() => {
  const {start,end,prices} = window();
  const rates = recordedYlpRates({start,end,startPrices: prices,endPrices: prices});
  // A million starting shares earn 0.001 base + 0.5 quote over one day on $200.
  // The ending supply doubles, which must not double the holder's earnings.
  assert.equal(rates.startingCapitalUsd,'200');
  assert.equal(rates.swapRatePct,'0.1825');
  assert.equal(rates.interestRatePct,'91.25');
  assert.equal(rates.claimableRatePct,'91.4325');
  assert.equal(rates.compoundedPrincipalIncluded,false);
  assert.equal(rates.unpaidInterestIncluded,false);
});

test('ending prices value earned tokens while starting prices value the initial capital',() => {
  const {start,end,prices} = window();
  const final = prices.map(price => ({...price,priceUsd:'2'}));
  const rates = recordedYlpRates({start,end,startPrices: prices,endPrices: final});
  assert.equal(rates.startingCapitalUsd,'200');
  assert.equal(rates.claimableRatePct,'182.865');
  end.blockTime = '2026-09-03T00:00:00Z';
  assert.equal(recordedYlpRates({start,end,startPrices: prices,endPrices: final}).claimableRatePct,'91.4325');
});

test('missing prices and zero capital stay unavailable, while a measured no-growth period is zero',() => {
  const {start,end,prices} = window();
  const read = (a=prices,b=prices) => recordedYlpRates({start,end,startPrices:a,endPrices:b});
  assert.equal(read([],prices).claimableRatePct,null);
  assert.equal(read(prices,[]).claimableRatePct,null);
  end.assets = structuredClone(start.assets);
  assert.equal(read(prices,[]).claimableRatePct,'0');
  start.supply = '0';
  assert.equal(read().claimableRatePct,null);
  start.supply = '1000000';
  start.assets.forEach(asset => {asset.reserve='0';});
  assert.equal(read().claimableRatePct,null);
});

test('committed market decoding rejects inconsistent ledgers, wrong PDA, and unsupported layouts',() => {
  const {fixture,point} = window();
  nativeFields(nativeFields(fixture.market.base_side).shares).ylp_supply='1';
  assert.throws(() => point(900000001,'2026-09-01T00:00:00Z'),/ledgers disagree/);
  nativeFields(nativeFields(fixture.market.base_side).shares).ylp_supply='1000000';
  fixture.market.version=2;
  assert.throws(() => point(900000001,'2026-09-01T00:00:00Z'),/provenance/);
  fixture.market.version=1;
  fixture.market.bump=0;
  assert.throws(() => point(900000001,'2026-09-01T00:00:00Z'),/PDA/);
});

test('regressed growth, reversed windows and changed asset precision cannot produce a rate',() => {
  const {start,end,prices}=window();
  const read=(last:MarketGrowthPoint) => recordedYlpRates({start,end:last,startPrices:prices,endPrices:prices});
  const bad=structuredClone(end);
  bad.assets[0].swapIndexQ64='0';
  assert.throws(() => read(bad),/regressed/);
  assert.throws(() => read({...end,slot:start.slot}),/window/);
  assert.throws(() => read({...end,blockTime:start.blockTime}),/window/);
  const precision=structuredClone(end);
  precision.assets[0].decimals=6;
  assert.throws(() => read(precision),/precision changed/);
  assert.throws(() => recordedYlpRates({start,end,startPrices:prices.map(p=>({...p,decimals:2})),endPrices:prices}),/precision/);
});
