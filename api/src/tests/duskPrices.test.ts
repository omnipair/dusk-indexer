import test from 'node:test';
import assert from 'node:assert/strict';
import { BorshCoder, Idl } from '@coral-xyz/anchor';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadPinnedProtocol } from '../config/duskProtocol';
import { multiplyPriceRatio, parsePriceReferences, positiveDecimal, projectMarketPrices, projectReferencePrices } from '../services/duskPriceMath';
import { priceFixture } from './duskPriceFixtures';

const pin = loadPinnedProtocol(),decoder = new BorshCoder(JSON.parse(readFileSync(resolve(__dirname,'../../../protocol/idl/dusk.json'),'utf8')) as Idl);
function project(fixture = priceFixture()) {
  const source = fixture.source();
  return projectMarketPrices({ pin,marketAddress: source.market,market: decoder.accounts.decode('Market',Buffer.from(source.rawMarket,'base64')),
    preview: decoder.types.decode('MarketPreview',Buffer.from(source.rawPreview,'base64')),slot: source.slot,blockTime: source.blockTime,references: source.references });
}

test('prices preserve exact decimal references and program quotes without floating-point rounding',() => {
  assert.equal(positiveDecimal('1.230000'),'1.23');
  assert.equal(multiplyPriceRatio('9007199254740993.123456789',2_500_000_000n,1_000_000_000n),'22517998136852482.8086419725');
  assert.equal(multiplyPriceRatio('1',1n,3n),'0.333333333333333333333333333333333333');
  for (const value of [1,'NaN','Infinity','1e-9','0','-1','01','0.0']) assert.throws(() => positiveDecimal(value));
});
test('curve preview, not reserve ratio or mint decimals, determines the derived reference',() => {
  const fixture = priceFixture(),result = project(fixture);
  const base = result.prices.find((price) => price.mint === fixture.baseMint)!;
  assert.equal(base.priceUsd,'2.5'); assert.equal(base.decimals,9); assert.equal(base.quality,'derived-reference');
  const quote = result.prices.find((price) => price.mint === fixture.quoteMint)!;
  assert.equal(quote.priceUsd,'1'); assert.equal(quote.decimals,6); assert.equal(quote.quality,'configured-reference');
});
test('missing or not-yet-effective references leave prices unavailable rather than assuming one dollar',() => {
  assert.equal(project(priceFixture({ references: false })).prices.length,0);
  assert.equal(project(priceFixture({ effectiveFrom: '2026-09-03T00:00:00Z' })).prices.length,0);
});
test('reference policies reject other networks, revisions and duplicate mints',() => {
  const refs = priceFixture().references;
  assert.throws(() => parsePriceReferences({ ...refs,cluster: 'mainnet-beta' },pin),/identity/);
  assert.throws(() => parsePriceReferences({ ...refs,protocolRevision: 'old' },pin),/identity/);
  assert.throws(() => parsePriceReferences({ ...refs,references: [...refs.references,...refs.references] },pin),/Duplicate/);
});
test('a USD stablecoin is an explicit one-dollar peg, and unmarked references normalize as before',() => {
  const refs = priceFixture().references,[reference] = refs.references;
  const marked = parsePriceReferences({ ...refs,references: [{ ...reference,priceUsd: '1.0',usdStablecoin: true }] },pin);
  assert.deepEqual(marked.references[0],{ ...reference,usdStablecoin: true });
  assert.deepEqual(Object.keys(parsePriceReferences(refs,pin).references[0]),['mint','priceUsd','note']);
  for (const change of [{ usdStablecoin: false },{ usdStablecoin: 'true' },{ usdStablecoin: true,priceUsd: '0.99' }])
    assert.throws(() => parsePriceReferences({ ...refs,references: [{ ...reference,...change }] },pin),/stablecoin/);
  const devnet = parsePriceReferences(JSON.parse(readFileSync(resolve(__dirname,'../../../protocol/devnet-price-references.json'),'utf8')),pin);
  assert.deepEqual(devnet.references.filter((entry) => entry.usdStablecoin).map((entry) => entry.mint),['G8XEiNtP7TZ2cZRbUdtcPoc3C19T2GgYxTJqBpWz5ZDV']);
});
test('before a first swap only each mint\'s own dated reference prices a market',() => {
  const fixture = priceFixture(),at = '2026-09-02T00:00:00Z';
  const created = { market: fixture.source().market,base_mint: fixture.baseMint,quote_mint: fixture.quoteMint,base_decimals: '9',quote_decimals: '6' };
  const plain = projectReferencePrices({ pin,market: created,blockTime: at,references: fixture.references });
  assert.deepEqual(plain.prices.map(({ mint,decimals,priceUsd,quality }) => [mint,decimals,priceUsd,quality]),
    [[fixture.quoteMint,6,'1','configured-reference']]);
  assert.deepEqual(plain.stablecoins,[]);
  const stable = { ...fixture.references,references: [{ ...fixture.references.references[0],usdStablecoin: true }] };
  assert.deepEqual(projectReferencePrices({ pin,market: created,blockTime: at,references: stable }).stablecoins,[fixture.quoteMint]);
  const early = projectReferencePrices({ pin,market: created,blockTime: '2026-08-31T00:00:00Z',references: stable });
  assert.deepEqual([early.prices,early.stablecoins],[[],[]]);
  assert.throws(() => projectReferencePrices({ pin,market: { ...created,quote_mint: fixture.baseMint },blockTime: at,references: stable }),/bindings/);
  assert.throws(() => projectReferencePrices({ pin,market: { ...created,base_decimals: '256' },blockTime: at,references: stable }),/overflow/);
});
test('a preview from a different bank cannot price this snapshot',() => {
  const source = priceFixture().source();
  assert.throws(() => projectMarketPrices({ pin,marketAddress: source.market,market: decoder.accounts.decode('Market',Buffer.from(source.rawMarket,'base64')),
    preview: decoder.types.decode('MarketPreview',Buffer.from(source.rawPreview,'base64')),slot: source.slot+1,blockTime: source.blockTime,references: source.references }),/observed bank/);
});

test('an unavailable on-chain quote does not erase the known reference asset',() => {
  const result = project(priceFixture({ quoteNad: 0n }));
  assert.equal(result.prices.length,1);
  assert.equal(result.prices[0].mint,priceFixture().quoteMint);
  assert.equal(result.prices[0].priceUsd,'1');
});
