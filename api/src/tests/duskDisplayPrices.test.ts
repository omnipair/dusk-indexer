import test from 'node:test';
import assert from 'node:assert/strict';
import { withDisplayPriceObservations, type DisplayPriceObservation } from '../services/duskDisplayPrices';

const at = '2026-11-15T00:00:00.000Z';
const market = () => ({ baseMint: 'base', quoteMint: 'quote', baseDecimals: 6, quoteDecimals: 9,
  state: { previewStatus: 'available' }, displayPrices: { schemaVersion: 'dusk-market-prices.v1',
    observedAt: at, referenceHash: 'a'.repeat(64), prices: [] as any[] } });
const quote = (changes: Partial<DisplayPriceObservation> = {}): DisplayPriceObservation => ({
  observationId: '1', mint: 'base', decimals: 6, priceUsd: '0.125', provider: 'jupiter',
  sourceTime: '2026-11-14T23:59:40.000Z', observedAt: '2026-11-14T23:59:41.000Z',
  deploymentIdentitySha256: 'b'.repeat(64), ...changes,
});

test('a floating-token market displays dated provider observations without a configured USD leg', () => {
  const input = market();
  const result = withDisplayPriceObservations(input,[quote(),quote({ mint: 'quote', decimals: 9, priceUsd: '3.1' })]);
  assert.deepEqual(result.displayPrices.prices.map((p: any) => [p.mint,p.priceUsd,p.quality]),
    [['base','0.125','external-observation'],['quote','3.1','external-observation']]);
  assert.equal(result.displayPrices.prices[0].reference.sourceTime,quote().sourceTime);
  assert.equal(input.displayPrices.prices.length,0);
});

test('a current provider quote replaces a curve-derived dollar estimate but preserves an explicit peg', () => {
  const input = market();
  input.displayPrices.prices = [
    { mint: 'base', priceUsd: '0.1', quality: 'derived-reference' },
    { mint: 'quote', priceUsd: '1', quality: 'configured-reference' },
  ];
  const result = withDisplayPriceObservations(input,[quote(),quote({ mint: 'quote', decimals: 9, priceUsd: '0.99' })]);
  assert.equal(result.displayPrices.prices[0].priceUsd,'0.125');
  assert.equal(result.displayPrices.prices[1].priceUsd,'1');
});

for (const [reason, changes] of Object.entries({
  'wrong mint': { mint: 'foreign' }, 'wrong decimals': { decimals: 9 }, 'old quote': { sourceTime: '2026-11-14T23:58:00Z' },
  'future observation': { observedAt: '2026-11-15T00:00:01Z' },
  'source newer than observation': { sourceTime: '2026-11-14T23:59:42Z' },
  'invalid price': { priceUsd: 'NaN' }, 'zero price': { priceUsd: '0' },
  'malformed deployment': { deploymentIdentitySha256: '' },
})) test(`ignores ${reason} rather than inventing a display value`, () => {
  assert.deepEqual(withDisplayPriceObservations(market(),[quote(changes)]).displayPrices.prices,[]);
});

test('provider data cannot supply display values when the protocol preview is unavailable', () => {
  const input = market(); input.state.previewStatus = 'unavailable';
  assert.equal(withDisplayPriceObservations(input,[quote()]),input);
});

test('historical valuation retains a dated prior quote without weakening live expiry or accepting later observations', () => {
  const old = quote({ sourceTime: '2026-11-14T23:50:00Z', observedAt: '2026-11-14T23:50:01Z' });
  assert.deepEqual(withDisplayPriceObservations(market(),[old]).displayPrices.prices,[]);
  const historical = withDisplayPriceObservations(market(),[old],['b'.repeat(64)],'historical');
  assert.equal(historical.displayPrices.prices[0].priceUsd,'0.125');
  assert.equal(historical.displayPrices.prices[0].reference.sourceTime,old.sourceTime);
  assert.deepEqual(withDisplayPriceObservations(market(),[quote({ observedAt: '2026-11-15T00:00:01Z' })],['b'.repeat(64)],'historical').displayPrices.prices,[]);
  assert.deepEqual(withDisplayPriceObservations(market(),[old],['c'.repeat(64)],'historical').displayPrices.prices,[]);
});
