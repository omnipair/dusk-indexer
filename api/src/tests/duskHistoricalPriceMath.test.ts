import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import pool from '../config/database';
import { canonicalJson } from '../config/duskProtocol';
import { historicalPriceAt, normalizeHistoricalPoints, reconstructPortfolioPrices, validateHistoricalPoint } from '../services/duskHistoricalPriceMath';
import { projectPortfolioSource } from '../services/duskPortfolioSnapshots';
import { portfolioFixture } from './duskPortfolioFixtures';

after(() => pool.end());
const from = new Date('2026-09-02T00:00:00Z'),until = new Date(from),fetched = new Date('2026-09-02T00:05:00Z');
function fixturePoints(source = portfolioFixture({ references: false }).source) {
  const balances = projectPortfolioSource(source).owners.flatMap(owner => owner.components.flatMap(component => component.balances));
  const mints = [...new Set(balances.map(balance => balance.mint))];
  return mints.flatMap((mint,index) => normalizeHistoricalPoints(mint,from,until,fetched,[{
    mint,provider: 'birdeye',timestamp: from,priceUsd: index === 0 ? 2.5 : 1,
  }]).map(point => ({ ...point,pointId: String(index+1) })));
}

test('minute history retains provider timestamps and exact decimal exponent values',() => {
  const mint = fixturePoints()[0].mint;
  const [point] = normalizeHistoricalPoints(mint,from,until,fetched,[{ mint,provider: 'birdeye',timestamp: from,priceUsd: 1e-8 }]);
  assert.equal(point.priceUsd,'0.00000001'); assert.equal(point.sourceTime,from.toISOString());
  assert.equal(point.fetchedAt,fetched.toISOString()); assert.equal(point.evidence.resolution,'1m');
  assert.equal(point.evidence.amountMode,'raw'); assert.equal(validateHistoricalPoint(point),point);
});
test('provider history rejects future, non-minute, wrong-mint and conflicting points',() => {
  const mint = fixturePoints()[0].mint,point = { mint,provider: 'birdeye' as const,timestamp: from,priceUsd: 2 };
  for (const change of [{ mint: fixturePoints()[1].mint },{ timestamp: new Date(from.getTime()+1000) },
    { timestamp: new Date(from.getTime()-60_000) },{ priceUsd: 0 },{ priceUsd: NaN },{ priceUsd: Infinity }])
    assert.throws(() => normalizeHistoricalPoints(mint,from,until,fetched,[{ ...point,...change }]));
  assert.throws(() => normalizeHistoricalPoints(mint,from,until,new Date(from.getTime()+60_000),[point]),/window/);
  assert.throws(() => normalizeHistoricalPoints(mint,from,until,fetched,[point,{ ...point,priceUsd: 3 }]),/Conflicting/);
  assert.throws(() => normalizeHistoricalPoints(mint,from,new Date(from.getTime()+7*3600_000),new Date('2026-09-03'),[]),/window/);
});
test('historical valuation selects only the same minute at or before capture time',() => {
  const [point] = fixturePoints();
  assert.equal(historicalPriceAt([point],point.mint,'2026-09-02T00:00:59.999Z'),point);
  assert.equal(historicalPriceAt([point],point.mint,'2026-09-01T23:59:59.999Z'),undefined);
  assert.equal(historicalPriceAt([point],point.mint,'2026-09-02T00:01:00.000Z'),undefined);
  assert.equal(historicalPriceAt([point],fixturePoints()[1].mint,point.sourceTime),undefined);
});
test('a repair replays saved amounts and debt without changing immutable source bytes',() => {
  const fixture = portfolioFixture({ references: false }),before = canonicalJson(fixture.source);
  const original = projectPortfolioSource(fixture.source).owners[0],rebuilt = reconstructPortfolioPrices(fixture.source,fixturePoints(fixture.source))[0];
  assert.equal(original.valuations.unvaluedComponents,2); assert.equal(rebuilt.valuations.unvaluedComponents,0);
  assert.equal(rebuilt.valuations.netPositionValueUsd,'51.95'); assert.equal(rebuilt.priceEvidence.length,3);
  assert.deepEqual(rebuilt.components.map(component => component.balances),original.components.map(component => component.balances));
  assert.deepEqual(rebuilt.components.map(component => component.sourceSlot),original.components.map(component => component.sourceSlot));
  assert.equal(canonicalJson(fixture.source),before);
  assert.ok(rebuilt.components.every(component => component.valuation.priceQualities.includes('historical-provider')));
});
test('a missing historical mint stays missing rather than borrowing another asset or today price',() => {
  const fixture = portfolioFixture({ references: false }),points = fixturePoints(fixture.source);
  const rebuilt = reconstructPortfolioPrices(fixture.source,[points[0]])[0];
  assert.equal(rebuilt.valuations.unvaluedComponents,1); assert.equal(rebuilt.valuations.netPositionValueUsd,null);
  assert.ok(rebuilt.components.some(component => component.valuation.missingMints.includes(points[1].mint)));
});
test('configured references and already-valued captures are not repriced',() => {
  const fixture = portfolioFixture(),original = projectPortfolioSource(fixture.source).owners[0];
  const rebuilt = reconstructPortfolioPrices(fixture.source,fixturePoints(fixture.source))[0];
  assert.deepEqual(rebuilt.components,original.components); assert.deepEqual(rebuilt.priceEvidence,[]);
});
test('a partially priced capture preserves its live quote and fills only the missing leg',() => {
  const fixture = portfolioFixture({ references: false }),points = fixturePoints(fixture.source);
  fixture.source.groups[0].displayPriceObservations = [{ observationId: '11',mint: points[0].mint,decimals: 9,priceUsd: '3',
    provider: 'jupiter',sourceTime: '2026-09-01T23:59:40.000Z',observedAt: '2026-09-01T23:59:41.000Z',deploymentIdentitySha256: 'b'.repeat(64) }];
  const original = projectPortfolioSource(fixture.source).owners[0],rebuilt = reconstructPortfolioPrices(fixture.source,points)[0];
  assert.equal(rebuilt.valuations.netPositionValueUsd,'57.34');
  assert.deepEqual(rebuilt.components.find(component => component.kind === 'borrow'),original.components.find(component => component.kind === 'borrow'));
  assert.ok(rebuilt.priceEvidence.every(evidence => evidence.mint === points[1].mint));
});
test('prices do not invent unavailable market previews, LP amounts or debt indexes',() => {
  const fixture = portfolioFixture({ references: false,previewUnavailable: true });
  const original = projectPortfolioSource(fixture.source).owners[0],rebuilt = reconstructPortfolioPrices(fixture.source,fixturePoints())[0];
  assert.deepEqual(rebuilt.components,original.components); assert.equal(rebuilt.valuations.netPositionValueUsd,null);
  assert.deepEqual(rebuilt.priceEvidence,[]);
});
test('tampered historical evidence or provenance is rejected before reconstruction',() => {
  const [point] = fixturePoints();
  for (const change of [{ contentHash: '0'.repeat(64) },{ priceUsd: '99' },{ mint: fixturePoints()[1].mint },
    { sourceTime: '2026-09-01T00:00:00Z' },{ fetchedAt: point.sourceTime }])
    assert.throws(() => validateHistoricalPoint({ ...point,...change }),/INVARIANT/);
});
