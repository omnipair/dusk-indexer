import test from 'node:test';
import assert from 'node:assert/strict';
import { activityPriceBasis, ActivityPriceBasis, parseActivityEvent, swapVolumeBasis, valueActivityAmounts } from '../services/duskActivityMath';
import { activityPayload, activitySlot, activityTime } from './duskActivityFixtures';
import { priceFixture } from './duskPriceFixtures';
import { externalPriceTargets, fetchExternalPrices } from '../services/duskExternalPrices';
import { parsePriceReferences } from '../services/duskPriceMath';
import { loadPinnedProtocol } from '../config/duskProtocol';

const parse = (name: string,changes = {},canonical = false) => parseActivityEvent(name,
  { ...activityPayload(name),...changes },String(activitySlot),canonical ? 'canonical-swap-events' : 'embedded-leverage-receipts');
const amount = (parsed: ReturnType<typeof parse>,metric: string) => parsed.amounts.find((entry) => entry.metric === metric)?.amount;

test('spot and margin overlap without treating the full exposure as swapped input',() => {
  const opened = parse('LeveragePositionOpened');
  assert.equal(amount(opened,'volume'),'2000000000');
  assert.equal(amount(opened,'marginVolume'),'3000000000');
  assert.equal(amount(opened,'creditVolume'),undefined);
  const canonical = parse('LeveragePositionOpened',{},true);
  assert.equal(amount(canonical,'volume'),undefined);
  assert.equal(amount(canonical,'swapFees'),undefined);
  assert.equal(amount(canonical,'marginVolume'),'3000000000');
  assert.equal(parse('SwapExecuted',{},true).hasSwap,true);
  assert.equal(swapVolumeBasis({ types: [{ name: 'SwapExecuted',type: { kind: 'struct',fields: [{ name: 'origin' }] } }] }),'canonical-swap-events');
  assert.equal(swapVolumeBasis({}),'embedded-leverage-receipts');
});
test('credit counts new principal only and rejects malformed signed deltas',() => {
  assert.equal(amount(parse('MarketDebtUpdated'),'creditVolume'),'2000000');
  for (const delta of ['0','-2000000']) assert.equal(amount(parse('MarketDebtUpdated',{ debt_delta: delta }),'creditVolume'),undefined);
  for (const delta of ['-0','1e3','9223372036854775808','-9223372036854775809',7])
    assert.throws(() => parse('MarketDebtUpdated',{ debt_delta: delta }),/i64/);
});
test('margin includes closes and liquidation, but not collateral-only deposits or withdrawals',() => {
  for (const name of ['LeveragePositionClosed','LeveragePositionLiquidated'])
    assert.equal(amount(parse(name),'marginVolume'),'1000000000');
  assert.equal(amount(parse('LeveragePositionUpdated',{ collateral_delta: '-2000000000' }),'marginVolume'),'2000000000');
  for (const delta of ['1000000','-1000000','0'])
    assert.equal(amount(parse('LeveragePositionUpdated',{ swap: null,borrowed_amount: '0',collateral_delta: delta }),'marginVolume'),undefined);
  assert.equal(amount(parse('LeveragePositionOpened',{ swap: null },true),'marginVolume'),'3000000000');
});

const fixture = priceFixture();
const basis = (): ActivityPriceBasis => ({ captureId: '1',slot: activitySlot-1,blockTime: '2026-09-02T00:00:05Z',
  bound: { baseMint: fixture.baseMint,quoteMint: fixture.quoteMint,baseDecimals: 9,quoteDecimals: 6 },
  spotPrices: { base: '2500000000',quote: '400000000' },prices: [
    { mint: fixture.baseMint,decimals: 9,priceUsd: '2.5',quality: 'derived-reference' },
    { mint: fixture.quoteMint,decimals: 6,priceUsd: '1',quality: 'configured-reference' } ] });
const provider = () => ({ observationId: '9',mint: fixture.quoteMint,decimals: 6,priceUsd: '2',
  sourceTime: '2026-09-02T00:00:06Z',observedAt: '2026-09-02T00:00:06Z' });
test('provider quotes precede on-chain fallback; price provenance stays in the valuation',() => {
  const prices = activityPriceBasis(basis(),[provider()],activityTime,60);
  assert.equal(prices.prices[0].priceUsd,'5');
  assert.equal(prices.prices[0].quality,'derived-reference');
  assert.equal(prices.prices[1].quality,'external-observation');
  const value = valueActivityAmounts(parse('LeveragePositionOpened').amounts,prices,activitySlot,activityTime,60);
  assert.equal(value[0].usd,'10');
  assert.equal(value[0].priceObservationId,'9');
});
test('future, stale and wrong-decimal provider quotes cannot override captured prices',() => {
  for (const change of [{ sourceTime: '2026-09-02T00:00:11Z' },{ observedAt: '2026-09-02T00:00:11Z' },
    { sourceTime: '2026-09-01T23:58:00Z' },{ decimals: 9 }])
    assert.deepEqual(activityPriceBasis(basis(),[{ ...provider(),...change }],activityTime,60).prices,basis().prices);
  assert.deepEqual(activityPriceBasis(basis(),[],activityTime,60).prices,basis().prices);
});
test('devnet provider lookups require an explicit mint mapping',() => {
  const refs = parsePriceReferences(fixture.references,loadPinnedProtocol());
  const assets = [{ mint: fixture.quoteMint,decimals: 6 }];
  assert.deepEqual(externalPriceTargets('devnet',refs,assets),[]);
  refs.references[0].externalMint = fixture.baseMint;
  assert.deepEqual(externalPriceTargets('devnet',refs,assets),[{ ...assets[0],externalMint: fixture.baseMint }]);
});
test('Jupiter outage and unlisted tokens still allow Birdeye, then the native fallback',async () => {
  const target = { mint: fixture.quoteMint,externalMint: fixture.quoteMint,decimals: 6 };
  for (const fetchImpl of [async () => new Response('',{ status: 503 }),async () => new Response('{}'),async () => { throw new Error('offline'); }]) {
    let calls = 0;
    const prices = await fetchExternalPrices([target],{ fetchImpl: fetchImpl as typeof fetch,
      now: () => new Date(activityTime),birdeye: async mint => { calls++; return { mint,priceUsd: 1.25,provider: 'birdeye' }; } });
    assert.equal(calls,1); assert.equal(prices[0].priceUsd,'1.25'); assert.equal(prices[0].sourceTime,activityTime);
    assert.deepEqual(await fetchExternalPrices([target],{ fetchImpl: fetchImpl as typeof fetch,birdeye: async () => null }),[]);
  }
});
test('Jupiter succeeds without calling Birdeye and preserves small decimal prices',async () => {
  const target = { mint: fixture.baseMint,externalMint: fixture.baseMint,decimals: 9 };
  const prices = await fetchExternalPrices([target],{ fetchImpl: (async () => Response.json({ [target.mint]: { usdPrice: 1e-9 } })) as typeof fetch,
    birdeye: async () => { throw new Error('unexpected fallback'); } });
  assert.equal(prices[0].priceUsd,'0.000000001'); assert.equal(prices[0].provider,'jupiter');
});
