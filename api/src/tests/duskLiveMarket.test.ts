import test from 'node:test';
import assert from 'node:assert/strict';
import { BorshCoder, BN } from '@coral-xyz/anchor';
import { MintLayout, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { PublicKey } from '@solana/web3.js';
import { currentMarketSnapshot, projectMarketSnapshot } from '../services/duskMarketService';
import { duskRawIdl, LiveMarketSimulationSnapshot } from '../services/duskMarketSimulation';
import { cache } from '../utils/cache';
import { portfolioFixture } from './duskPortfolioFixtures';
import { encodeFixtureAccount, encodeFixtureType, fixtureKey } from './duskYieldCheckpointFixtures';

function liveFixture() {
  const fixture = portfolioFixture(),group = fixture.source.groups[0],decoder = new BorshCoder(duskRawIdl());
  const market = decoder.accounts.decode('Market',Buffer.from(group.marketAccount.data,'base64')) as any;
  const preview = decoder.types.decode('MarketPreview',Buffer.from(group.preview!,'base64')) as any;
  // The curve price differs from reserve ratio. Accrued isolated debt and
  // hLP funding debt must both survive the API/UI adapter.
  preview.base.spot_price_nad = new BN(3_000_000_000);
  preview.base.total_debt = new BN(7_000_000_000);
  preview.base.isolated_debt = new BN(2_000_000_000);
  preview.base.hlp_funding_debt = new BN(4_000_000_000);
  market.debt.fixed_base_shares = new BN(1_000_000_000);
  market.debt.base_borrow_index_nad = new BN(1_100_000_000);
  const accounts = ['base','quote'].map((side) => {
    const state = market[`${side}_side`],raw = Buffer.alloc(MintLayout.span);
    MintLayout.encode({ mintAuthorityOption: 0,mintAuthority: fixtureKey(0),supply: 100n,
      decimals: state.asset_decimals,isInitialized: true,freezeAuthorityOption: 0,freezeAuthority: fixtureKey(0) },raw);
    return { address: state.asset_mint.toBase58(),account: { owner: TOKEN_2022_PROGRAM_ID.toBase58(),executable: false,data: raw.toString('base64') } };
  });
  const snapshot: LiveMarketSimulationSnapshot = { ...group,commitment: 'confirmed',accounts,
    marketAccount: { ...group.marketAccount,data: encodeFixtureAccount('Market',market).toString('base64') },
    preview: encodeFixtureType('MarketPreview',preview).toString('base64') };
  return { snapshot,market,references: fixture.source.references };
}
test('live payload uses one bank and preserves program debt, curve price and explicit USD references',() => {
  const sample = liveFixture(),payload = projectMarketSnapshot(sample.snapshot,sample.references) as any;
  assert.equal(payload.state.sourceSlot,sample.snapshot.slot); assert.equal(payload.state.healthSourceSlot,sample.snapshot.slot);
  assert.equal(payload.state.fixedBaseDebt,'1100000000'); assert.equal(payload.state.baseTotalDebt,'7000000000');
  assert.equal(payload.state.baseIsolatedDebt,'2000000000'); assert.equal(payload.state.baseHlpFundingDebt,'4000000000');
  assert.equal(payload.state.baseSpotPriceNad,'3000000000'); assert.equal(payload.state.previewStatus,'available');
  assert.equal(payload.displayPrices.prices.find((row: any) => row.mint === payload.baseMint).priceUsd,'3');
  assert.equal(payload.displayPrices.prices.find((row: any) => row.mint === payload.baseMint).quality,'derived-reference');
});
test('a failed preview preserves market inventory and marks every preview-only value unavailable',() => {
  const sample = liveFixture(),payload = projectMarketSnapshot({ ...sample.snapshot,preview: null,basis: 'rpc-account',previewUnavailable: true },sample.references) as any;
  assert.equal(payload.marketAddress,sample.snapshot.market); assert.equal(payload.state.baseLiveReserve,'100000000000');
  for (const field of ['baseTotalDebt','baseBorrowAprNad','baseSpotPriceNad','baseDebtHealthBps','healthSourceSlot']) assert.equal(payload.state[field],null);
  assert.equal(payload.state.previewStatus,'unavailable'); assert.equal(payload.state.stateBasis,'rpc-account');
  assert.deepEqual(payload.displayPrices.prices,[]);
});
test('a missing or foreign mint cannot be used as the market token program',() => {
  const sample = liveFixture(); sample.snapshot.accounts[0].account!.owner = fixtureKey(198).toBase58();
  assert.throws(() => projectMarketSnapshot(sample.snapshot,sample.references),/token program/);
  sample.snapshot.accounts=[];
  assert.throws(() => projectMarketSnapshot(sample.snapshot,sample.references),/omits a mint/);
});
test('snapshot caching respects a newer discovery or confirmation floor and full identity',async () => {
  cache.clear(); const sample = liveFixture(),market = new PublicKey(sample.snapshot.market),calls: number[] = [];
  const capture = async (_market: string,minSlot: number) => { calls.push(minSlot); return { ...sample.snapshot,slot: minSlot }; };
  const identity = sample.snapshot.deploymentIdentitySha256;
  await currentMarketSnapshot(market,sample.market,100,identity,capture);
  await currentMarketSnapshot(market,sample.market,99,identity,capture);
  const newer = await currentMarketSnapshot(market,sample.market,101,identity,capture);
  assert.equal(newer.slot,101); assert.deepEqual(calls,[100,101]);
  await assert.rejects(currentMarketSnapshot(market,sample.market,101,'c'.repeat(64),capture),/identity or slot/);
  cache.clear();
});
