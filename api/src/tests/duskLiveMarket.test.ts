import test from 'node:test';
import assert from 'node:assert/strict';
import { BorshCoder, BN } from '@coral-xyz/anchor';
import { AccountLayout, AccountState, MintLayout, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { PublicKey } from '@solana/web3.js';
import { currentMarketSnapshot, projectMarketSnapshot } from '../services/duskMarketService';
import { duskRawIdl, LiveMarketSimulationSnapshot } from '../services/duskMarketSimulation';
import { cache } from '../utils/cache';
import { portfolioFixture } from './duskPortfolioFixtures';
import { encodeFixtureAccount, encodeFixtureType, fixtureKey } from './duskYieldCheckpointFixtures';
import { leverageCollateralAddress } from '../services/duskMarketExtras';

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
  const vaults = ['base','quote'].flatMap((side,index) => {
    const state = market[`${side}_side`];
    return ['reserve','collateral','leverage'].map((kind,offset) => {
      const address = kind === 'leverage' ? new PublicKey(leverageCollateralAddress(group.market,state.asset_mint.toBase58())) : fixtureKey(200+index*3+offset);
      if (kind !== 'leverage') state[`${kind}_vault`] = address;
      const raw = Buffer.alloc(AccountLayout.span);
      AccountLayout.encode({ mint: state.asset_mint,owner: new PublicKey(group.market),amount: BigInt((offset+1)*100),
        delegateOption: 0,delegate: fixtureKey(0),state: AccountState.Initialized,isNativeOption: 0,isNative: 0n,
        delegatedAmount: 0n,closeAuthorityOption: 0,closeAuthority: fixtureKey(0) },raw);
      return { address: address.toBase58(),account: { owner: TOKEN_2022_PROGRAM_ID.toBase58(),executable: false,data: raw.toString('base64') } };
    });
  });
  const snapshot: LiveMarketSimulationSnapshot = { ...group,commitment: 'confirmed',accounts: [...accounts,...vaults],
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
  assert.deepEqual(payload.deposits,{ schemaVersion: 'dusk-market-deposits.v1',sourceSlot: sample.snapshot.slot,basis: 'reserve-and-collateral-custody.v1',
    baseReserveAmount: '100',quoteReserveAmount: '100',baseCollateralAmount: '200',quoteCollateralAmount: '200',baseLeverageAmount: '300',quoteLeverageAmount: '300' });
  assert.equal(payload.tokenMetadata.base,null);
});

test('deposits reject foreign vaults and only an observed absent leverage PDA is zero',() => {
  const sample = liveFixture(),vault = sample.snapshot.accounts[2];
  vault.account!.owner = fixtureKey(197).toBase58();
  assert.throws(() => projectMarketSnapshot(sample.snapshot,sample.references),/valid collateral vault/);
  vault.account!.owner = TOKEN_2022_PROGRAM_ID.toBase58();
  const leverage = sample.snapshot.accounts.find((item) => item.address === leverageCollateralAddress(sample.snapshot.market,sample.market.base_side.asset_mint.toBase58()))!;
  leverage.account = null;
  assert.equal((projectMarketSnapshot(sample.snapshot,sample.references) as any).deposits.baseLeverageAmount,'0');
  leverage.account = { owner: PublicKey.default.toBase58(),executable: false,data: '' };
  assert.equal((projectMarketSnapshot(sample.snapshot,sample.references) as any).deposits.baseLeverageAmount,'0');
  sample.snapshot.accounts = sample.snapshot.accounts.filter((item) => item !== leverage);
  assert.throws(() => projectMarketSnapshot(sample.snapshot,sample.references),/valid collateral vault/);
});
test('a failed preview preserves market inventory and marks every preview-only value unavailable',() => {
  const sample = liveFixture(),payload = projectMarketSnapshot({ ...sample.snapshot,preview: null,basis: 'rpc-account',previewUnavailable: true },sample.references) as any;
  assert.equal(payload.marketAddress,sample.snapshot.market); assert.equal(payload.state.baseLiveReserve,'100000000000');
  for (const field of ['baseTotalDebt','baseBorrowAprNad','baseSpotPriceNad','baseDebtHealthBps','healthSourceSlot']) assert.equal(payload.state[field],null);
  assert.equal(payload.state.previewStatus,'unavailable'); assert.equal(payload.state.stateBasis,'rpc-account');
  assert.deepEqual(payload.displayPrices.prices,[]);
});
test('insurance caps and both draw windows come from the same decoded market bank even without a preview',() => {
  const sample = liveFixture();
  sample.market.insurance.per_event_draw_bps = 700;
  sample.market.insurance.per_day_draw_bps = 1500;
  sample.market.insurance.base_available = new BN('9007199254740993');
  sample.market.insurance.base_draw_window = { start_slot: new BN(12), opening_available: new BN('9007199254740993'), credited: new BN(55), drawn: new BN(23) };
  sample.market.insurance.quote_draw_window = { start_slot: new BN(13), opening_available: new BN(21), credited: new BN(8), drawn: new BN(5) };
  const payload = projectMarketSnapshot({ ...sample.snapshot, preview: null, basis: 'rpc-account', previewUnavailable: true,
    marketAccount: { ...sample.snapshot.marketAccount, data: encodeFixtureAccount('Market',sample.market).toString('base64') } },sample.references) as any;
  assert.equal(payload.state.baseInsuranceAvailable,'9007199254740993');
  assert.deepEqual(payload.insurance, { perEventDrawBps: 700, perDayDrawBps: 1500,
    baseWindow: { startSlot: '12', openingAvailable: '9007199254740993', credited: '55', drawn: '23' },
    quoteWindow: { startSlot: '13', openingAvailable: '21', credited: '8', drawn: '5' } });
  assert.equal(payload.state.sourceSlot,sample.snapshot.slot);
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
