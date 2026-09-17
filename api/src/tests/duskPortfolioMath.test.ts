import test from 'node:test';
import assert from 'node:assert/strict';
import { PublicKey } from '@solana/web3.js';
import { loadPinnedProtocol } from '../config/duskProtocol';
import { assertPortfolioPreviewState, formatUsd, hlpPortfolioPrincipal, indexedPortfolioDebt, nativeFields,
  PortfolioKind, projectPortfolioComponent, totalPortfolioComponents, usdUnits, valuePortfolioBalances } from '../services/duskPortfolioMath';
import { checkpointFixture, fixtureKey } from './duskYieldCheckpointFixtures';
import { priceFixture } from './duskPriceFixtures';

const NAD = 1_000_000_000n;
function fixture() {
  const base = checkpointFixture(),marketAddress = base.source().market,market = base.market,slot = 900000001;
  const debt = nativeFields(market.debt);
  debt.base_borrow_index_nad = 1_250_000_000n;
  debt.quote_borrow_index_nad = 1_100_000_000n;
  const preview: Record<string,unknown> = { slot };
  for (const side of ['base','quote'] as const) {
    const raw = nativeFields(market[`${side}_side`]);
    const live = side === 'base' ? 100n*NAD : 250_000_000n;
    Object.assign(nativeFields(raw.reserves),{ live_reserve: live,cash_reserve: live });
    nativeFields(raw.shares).ylp_supply = 1_000_000n;
    preview[side] = { live_reserve: live,cash_reserve: live,ylp_supply: 1_000_000n,
      borrow_index_nad: debt[`${side}_borrow_index_nad`],spot_price_nad: side === 'base' ? 2_500_000_000n : 400_000_000n };
  }
  function component(kind: PortfolioKind,changes: Record<string,unknown> = {},unavailable = false) {
    const positionId = fixtureKey(121);
    const [position,bump] = PublicKey.findProgramAddressSync([Buffer.from(kind === 'borrow' ? 'borrow_position_v2' : 'leverage_position_v2'),
      new PublicKey(marketAddress).toBuffer(),positionId.toBuffer()],new PublicKey(base.programId));
    const state = { owner: base.owner,market: marketAddress,position_id: positionId,bump,
      mint: kind === 'ylp' ? market.ylp_mint : nativeFields(market[`${kind === 'base_hlp' ? 'base' : 'quote'}_side`]).hlp_mint,
      amount: 100_000n,base_collateral: 2n*NAD,quote_collateral: 3_000_000n,fixed_base_shares: NAD,fixed_quote_shares: 0n,
      debt_asset: 1,collateral_amount: 2n*NAD,debt_shares: 1_000_000n,margin_amount: NAD,open_notional: 1_000_000n,...changes };
    return projectPortfolioComponent({ pin: loadPinnedProtocol(),kind,address: ['borrow','leverage'].includes(kind) ? position.toBase58() : fixtureKey(122).toBase58(),
      marketAddress,market,preview: unavailable ? null : preview,state,slot,blockTime: '2026-09-02T00:00:00Z',references: priceFixture().references });
  }
  return { market,preview,component };
}

test('indexed debt floors interest and preserves the program product overflow check',() => {
  assert.equal(indexedPortfolioDebt(3n,1_500_000_000n),4n);
  assert.equal(indexedPortfolioDebt(0n,0n),0n);
  assert.throws(() => indexedPortfolioDebt(1n,0n),/borrow index/);
  assert.throws(() => indexedPortfolioDebt((1n<<128n)-1n,NAD));
});
test('borrow equity uses both collaterals and indexed debt with exact decimals',() => {
  const component = fixture().component('borrow');
  assert.equal(component.valuation.assetsUsd,'8');
  assert.equal(component.valuation.debtUsd,'3.125');
  assert.equal(component.valuation.netUsd,'4.875');
});
test('leverage collateral already includes margin and uses the opposite debt asset',() => {
  const component = fixture().component('leverage',{ margin_amount: 1_000_000n*NAD,open_notional: 999_999_999n });
  assert.equal(component.valuation.assetsUsd,'5');
  assert.equal(component.valuation.debtUsd,'1.1');
  assert.equal(component.valuation.netUsd,'3.9');
});
test('a yLP holder owns a fraction of each reserve using one internal share supply',() => {
  const component = fixture().component('ylp');
  assert.deepEqual(component.balances.map((balance) => balance.amount),['10000000000','25000000']);
  assert.equal(component.valuation.netUsd,'50');
});
test('position ownership seeds, mint bindings and same-bank preview ledgers are checked',() => {
  assert.throws(() => fixture().component('borrow',{ position_id: fixtureKey(123) }),/PDA/);
  assert.throws(() => fixture().component('ylp',{ mint: fixtureKey(123) }),/wrong mint/);
  const sample = fixture();
  nativeFields(sample.preview.base).borrow_index_nad = NAD;
  assert.throws(() => assertPortfolioPreviewState(sample.market,sample.preview),/index/);
  const other = fixture();
  nativeFields(nativeFields(other.market.quote_side).shares).ylp_supply = 2_000_000n;
  assert.throws(() => other.component('ylp'),/ledgers/);
});
test('hLP principal subtracts indexed funding debt and excludes unrealized lending interest from inventory',() => {
  const sample = fixture(),debt = nativeFields(sample.market.debt);
  Object.assign(nativeFields(sample.market.base_hlp_vault),{ hlp_supply: 1_000_000n,ylp_shares: 200_000n,debt_shares: 10_000_000n });
  // Five base units of unrealized interest: 20 shares * 1.25 minus 20 principal.
  Object.assign(debt,{ fixed_base_shares: 20n*NAD,fixed_base_principal: 20n*NAD });
  const value = hlpPortfolioPrincipal(sample.market,sample.preview,'base',100_000n);
  // 19 base + 50 quote / 2.5 - 11 quote / 2.5 = 34.6 base in vault; holder owns 10%.
  assert.equal(value.signedVaultNav,'34600000000');
  assert.equal(value.amount,3_460_000_000n);
  assert.equal(sample.component('base_hlp').valuation.netUsd,'8.65');
});
test('quote hLP uses the program base price and reciprocal with different mint decimals',() => {
  const sample = fixture();
  Object.assign(nativeFields(sample.market.quote_hlp_vault),{ hlp_supply: 1_000_000n,ylp_shares: 200_000n,debt_shares: 4n*NAD });
  // 50 quote + 20 base * 2.5 - 5 base * 2.5 = 87.5 quote; holder owns 10%.
  assert.equal(hlpPortfolioPrincipal(sample.market,sample.preview,'quote',100_000n).amount,8_750_000n);
});
test('wide hLP quantity arithmetic permits a valid quotient even when its product exceeds u128',() => {
  const sample = fixture(),market = sample.market;
  nativeFields(market.base_side).asset_decimals = 0;
  nativeFields(market.quote_side).asset_decimals = 20;
  Object.assign(nativeFields(market.quote_hlp_vault),{ hlp_supply: 1n,ylp_shares: 1_000_000n,debt_shares: 0n });
  Object.assign(nativeFields(nativeFields(market.base_side).reserves),{ live_reserve: 100_000_000_000n });
  nativeFields(nativeFields(market.quote_side).reserves).live_reserve = 0n;
  // The final raw amount cannot fit a u64 here, but the NAV itself is representable.
  // A zero holding isolates the wide NAV calculation from output conversion.
  const value = hlpPortfolioPrincipal(market,sample.preview,'quote',0n);
  assert.equal(value.signedVaultNav,(250_000_000_000n*10n**20n).toString());
  assert.equal(value.amount,0n);
});
test('underwater hLP is visible with zero limited-liability principal and signed NAV evidence',() => {
  const sample = fixture();
  Object.assign(nativeFields(sample.market.base_hlp_vault),{ hlp_supply: 1_000_000n,ylp_shares: 0n,debt_shares: 10_000_000n });
  const component = sample.component('base_hlp');
  assert.equal(component.valuation.netUsd,'0');
  assert.equal(component.hlpNav?.signedVaultNav,'-4400000000');
  assert.ok(component.issues.includes('hlp-underwater'));
});
test('unavailable previews and missing prices never become a complete zero portfolio',() => {
  const good = fixture().component('ylp'),unknown = fixture().component('borrow',{},true);
  const total = totalPortfolioComponents([good,unknown]);
  assert.equal(total.netPositionValueUsd,null); assert.equal(total.knownNetSubtotalUsd,'50');
  assert.equal(total.quality,'incomplete'); assert.equal(total.unvaluedComponents,1);
  assert.equal(valuePortfolioBalances(good.balances,[]).netUsd,null);
  assert.equal(valuePortfolioBalances([{ ...good.balances[0],amount: '0' }],[]).netUsd,'0');
  assert.equal(totalPortfolioComponents([]).quality,'empty');
});
test('USD values keep integer precision beyond JavaScript numbers and reject invalid decimals',() => {
  const value = '-9007199254740993.123456789123456789123456789123456789';
  assert.equal(formatUsd(usdUnits(value)),value);
  const balance = { mint: fixtureKey(111).toBase58(),decimals: 0,amount: '9007199254740993',role: 'asset' as const };
  assert.equal(valuePortfolioBalances([balance],[{ mint: balance.mint,decimals: 0,priceUsd: '1.5',quality: 'configured-reference' }]).netUsd,'13510798882111489.5');
  assert.throws(() => valuePortfolioBalances([{ ...balance,decimals: -1 }],[]),/decimals/);
});
