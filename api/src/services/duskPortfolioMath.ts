import { PublicKey } from '@solana/web3.js';
import { DuskPinnedProtocol } from '../config/duskProtocol';
import { priceMarketBindings, projectMarketPrices } from './duskPriceMath';
import { unsigned } from './duskYieldAccounting';

const NAD = 1_000_000_000n,U64 = (1n<<64n)-1n,U128 = (1n<<128n)-1n,USD_SCALE = 10n**36n;
export type PortfolioKind = 'borrow'|'leverage'|'ylp'|'base_hlp'|'quote_hlp';
export const nativeFields = (value: unknown): Record<string,unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Missing native portfolio fields');
  return value as Record<string,unknown>;
};
export const nativeKey = (value: unknown): string => {
  const text = value instanceof PublicKey ? value.toBase58() : value;
  if (typeof text !== 'string' || new PublicKey(text).toBase58() !== text) throw new Error('Invalid native portfolio address');
  return text;
};
const checked = (value: bigint) => unsigned(value,U128);
const multiplyDivide = (left: bigint,right: bigint,denominator: bigint) => {
  if (denominator<=0n) throw new Error('Invalid native share denominator');
  // Rust mul_div_u128 allows a wider product, then bounds the quotient.
  return checked(checked(left)*checked(right)/checked(denominator));
};
export function indexedPortfolioDebt(shares: unknown,index: unknown): bigint {
  const amount = unsigned(shares),borrowIndex = unsigned(index);
  if (amount>0n && borrowIndex === 0n) throw new Error('Debt shares have no borrow index');
  // Debt::shares_to_debt bounds the product before division instead.
  return amount === 0n ? 0n : checked(amount*borrowIndex)/NAD;
}
export function usdUnits(value: string): bigint {
  if (!/^-?(0|[1-9]\d*)(\.\d{1,36})?$/.test(value)) throw new Error('Invalid exact USD amount');
  const negative = value.startsWith('-'),[whole,fraction=''] = value.replace(/^-/,'').split('.');
  const units = BigInt(whole)*USD_SCALE+BigInt(fraction.padEnd(36,'0'));
  return negative ? -units : units;
}
export function formatUsd(units: bigint): string {
  const negative = units<0n,magnitude = negative ? -units : units;
  const fraction = (magnitude%USD_SCALE).toString().padStart(36,'0').replace(/0+$/,'');
  return `${negative ? '-' : ''}${magnitude/USD_SCALE}${fraction ? `.${fraction}` : ''}`;
}
export interface PortfolioBalance { mint: string; decimals: number; amount: string; role: 'asset'|'debt' }
export interface PortfolioValuation {
  assetsUsd: string | null; debtUsd: string | null; netUsd: string | null;
  missingMints: string[]; priceQualities: string[]; rounding: 'down-36-decimals';
}
export function valuePortfolioBalances(balances: PortfolioBalance[], prices: { mint: string; decimals: number; priceUsd: string; quality: string }[]): PortfolioValuation {
  let assets = 0n,debt = 0n,missingAssets = false,missingDebt = false;
  const missing = new Set<string>(),qualities = new Set<string>();
  for (const balance of balances) {
    if (!Number.isSafeInteger(balance.decimals) || balance.decimals<0 || balance.decimals>255) throw new Error('Invalid portfolio asset decimals');
    const amount = unsigned(balance.amount);
    if (amount === 0n) continue;
    const price = prices.find((price) => price.mint === balance.mint);
    if (!price) { missing.add(balance.mint); if (balance.role === 'asset') missingAssets = true; else missingDebt = true; continue; }
    if (price.decimals !== balance.decimals || usdUnits(price.priceUsd)<=0n) throw new Error('Portfolio price does not match its mint');
    const value = amount*usdUnits(price.priceUsd)/(10n**BigInt(balance.decimals));
    if (balance.role === 'asset') assets += value; else debt += value;
    qualities.add(price.quality);
  }
  return { assetsUsd: missingAssets ? null : formatUsd(assets),debtUsd: missingDebt ? null : formatUsd(debt),
    netUsd: missingAssets || missingDebt ? null : formatUsd(assets-debt),missingMints: [...missing].sort(),
    priceQualities: [...qualities].sort(),rounding: 'down-36-decimals' };
}
function sideOf(market: Record<string,unknown>,side: 'base'|'quote') { return nativeFields(market[`${side}_side`]); }
function indexOf(market: Record<string,unknown>,side: 'base'|'quote') { return unsigned(nativeFields(market.debt)[`${side}_borrow_index_nad`]); }
function shareSupply(market: Record<string,unknown>): bigint {
  const base = unsigned(nativeFields(sideOf(market,'base').shares).ylp_supply,U64);
  if (base !== unsigned(nativeFields(sideOf(market,'quote').shares).ylp_supply,U64)) throw new Error('Inconsistent yLP share ledgers');
  return base;
}
/** PreviewMarket mutates only the simulated account; it must agree with its return data. */
export function assertPortfolioPreviewState(market: Record<string,unknown>,preview: Record<string,unknown>): void {
  shareSupply(market);
  for (const side of ['base','quote'] as const) {
    const raw = sideOf(market,side),observed = nativeFields(preview[side]),reserves = nativeFields(raw.reserves);
    for (const name of ['live_reserve','cash_reserve'] as const)
      if (unsigned(reserves[name],U64) !== unsigned(observed[name],U64)) throw new Error('Simulated portfolio reserves differ from the preview');
    if (unsigned(nativeFields(raw.shares).ylp_supply,U64) !== unsigned(observed.ylp_supply,U64) || indexOf(market,side) !== unsigned(observed.borrow_index_nad))
      throw new Error('Simulated portfolio shares/index differ from the preview');
  }
}
function curveReserve(market: Record<string,unknown>,side: 'base'|'quote'): bigint {
  const debt = nativeFields(market.debt),index = indexOf(market,side);
  const fixed = indexedPortfolioDebt(debt[`fixed_${side}_shares`],index),isolated = indexedPortfolioDebt(debt[`isolated_${side}_shares`],index);
  const fixedPrincipal = unsigned(debt[`fixed_${side}_principal`],U64),isolatedPrincipal = unsigned(debt[`isolated_${side}_principal`],U64);
  const interest = (fixed>fixedPrincipal ? fixed-fixedPrincipal : 0n)+(isolated>isolatedPrincipal ? isolated-isolatedPrincipal : 0n);
  const live = unsigned(nativeFields(sideOf(market,side).reserves).live_reserve,U64);
  if (interest>live) throw new Error('Unrealized interest exceeds live reserves');
  return live-interest;
}

/** Dusk's current hLP principal NAV in the target-asset quantity scale, not an exit quote. */
export function hlpPortfolioPrincipal(market: Record<string,unknown>,preview: Record<string,unknown>,target: 'base'|'quote',holding: bigint) {
  const opposite = target === 'base' ? 'quote' : 'base',vault = nativeFields(market[`${target}_hlp_vault`]);
  const supply = unsigned(vault.hlp_supply,U64),ylp = unsigned(vault.ylp_shares,U64),ylpSupply = shareSupply(market);
  if (holding>supply || ylp>ylpSupply) throw new Error('hLP holding exceeds its share backing');
  const targetDecimals = Number(unsigned(sideOf(market,target).asset_decimals,255n));
  const oppositeDecimals = Number(unsigned(sideOf(market,opposite).asset_decimals,255n));
  const scale = Math.max(9,targetDecimals,oppositeDecimals);
  const underlying = (side: 'base'|'quote') => ylp === 0n ? 0n : unsigned(multiplyDivide(ylp,curveReserve(market,side),ylpSupply),U64);
  const borrowed = unsigned(indexedPortfolioDebt(vault.debt_shares,indexOf(market,opposite)),U64);
  const basePrice = unsigned(nativeFields(preview.base).spot_price_nad,U64);
  if (basePrice === 0n) throw new Error('hLP valuation has no executable price');
  // The program derives the reciprocal from this same base price.
  const quotePrice = unsigned(NAD*NAD/basePrice,U64);
  if (quotePrice === 0n) throw new Error('hLP reciprocal price underflow');
  const normalize = (amount: bigint,decimals: number) => checked(amount*10n**BigInt(scale-decimals));
  const oppositePrice = opposite === 'base' ? basePrice : quotePrice;
  const targetValue = normalize(underlying(target),targetDecimals);
  const oppositeValue = multiplyDivide(normalize(underlying(opposite),oppositeDecimals),oppositePrice,NAD);
  const debtValue = multiplyDivide(normalize(borrowed,oppositeDecimals),oppositePrice,NAD);
  const signedNav = checked(targetValue+oppositeValue)-debtValue;
  const principal = signedNav>0n && holding>0n ? multiplyDivide(signedNav,holding,supply)/10n**BigInt(scale-targetDecimals) : 0n;
  return { amount: unsigned(principal,U64),signedVaultNav: signedNav.toString(),quantityDecimals: scale,underwater: signedNav<0n };
}

export function projectPortfolioComponent(input: {
  pin: DuskPinnedProtocol; kind: PortfolioKind; address: string; marketAddress: string; market: unknown; preview: unknown | null;
  state: unknown; slot: number; blockTime: string; references: unknown;
}) {
  const market = nativeFields(input.market),state = nativeFields(input.state);
  const bound = priceMarketBindings(input.pin.dusk.programId,input.marketAddress,market);
  const owner = nativeKey(state.owner),balances: PortfolioBalance[] = [],issues: string[] = [];
  const add = (side: 'base'|'quote',amount: bigint,role: 'asset'|'debt') => balances.push({ mint: side === 'base' ? bound.baseMint : bound.quoteMint,
    decimals: side === 'base' ? bound.baseDecimals : bound.quoteDecimals,amount: amount.toString(),role });
  if (input.kind === 'borrow' || input.kind === 'leverage') {
    if (nativeKey(state.market) !== input.marketAddress) throw new Error('Portfolio position belongs to another market');
    const seed = input.kind === 'borrow' ? 'borrow_position_v2' : 'leverage_position_v2';
    const [address,bump] = PublicKey.findProgramAddressSync([Buffer.from(seed),new PublicKey(input.marketAddress).toBuffer(),
      new PublicKey(nativeKey(state.position_id)).toBuffer()],new PublicKey(input.pin.dusk.programId));
    if (address.toBase58() !== input.address || unsigned(state.bump,255n) !== BigInt(bump)) throw new Error('Portfolio position PDA mismatch');
  }
  const preview = input.preview === null ? null : nativeFields(input.preview);
  if (preview) assertPortfolioPreviewState(market,preview); else issues.push('market-preview-unavailable');
  let hlpNav: ReturnType<typeof hlpPortfolioPrincipal> | null = null;
  if (input.kind === 'borrow') {
    add('base',unsigned(state.base_collateral,U64),'asset'); add('quote',unsigned(state.quote_collateral,U64),'asset');
    if (preview) {
      add('base',indexedPortfolioDebt(state.fixed_base_shares,indexOf(market,'base')),'debt');
      add('quote',indexedPortfolioDebt(state.fixed_quote_shares,indexOf(market,'quote')),'debt');
    }
  } else if (input.kind === 'leverage') {
    const debtSide = unsigned(state.debt_asset,1n) === 0n ? 'base' : 'quote';
    add(debtSide === 'base' ? 'quote' : 'base',unsigned(state.collateral_amount,U64),'asset');
    if (preview) add(debtSide,unsigned(indexedPortfolioDebt(state.debt_shares,indexOf(market,debtSide)),U64),'debt');
    // margin_amount and open_notional are cost-basis fields, not extra assets.
  } else {
    const holding = unsigned(state.amount,U64),mint = nativeKey(state.mint);
    const expected = input.kind === 'ylp' ? nativeKey(market.ylp_mint) : nativeKey(sideOf(market,input.kind === 'base_hlp' ? 'base' : 'quote').hlp_mint);
    if (mint !== expected) throw new Error('Portfolio LP account has the wrong mint');
    if (preview && input.kind === 'ylp') {
      const supply = shareSupply(market);
      if (holding>supply) throw new Error('LP holding exceeds market supply');
      for (const side of ['base','quote'] as const)
        add(side,holding === 0n ? 0n : unsigned(multiplyDivide(holding,unsigned(nativeFields(sideOf(market,side).reserves).live_reserve,U64),supply),U64),'asset');
    } else if (preview) {
      const target = input.kind === 'base_hlp' ? 'base' : 'quote';
      hlpNav = hlpPortfolioPrincipal(market,preview,target,holding);
      add(target,hlpNav.amount,'asset');
      if (hlpNav.underwater) issues.push('hlp-underwater');
    }
  }
  const priced = preview ? projectMarketPrices({ pin: input.pin,marketAddress: input.marketAddress,market,preview,
    slot: input.slot,blockTime: input.blockTime,references: input.references }) : null;
  const valuation: PortfolioValuation = priced ? valuePortfolioBalances(balances,priced.prices)
    : { assetsUsd: null,debtUsd: null,netUsd: null,missingMints: [],priceQualities: [],rounding: 'down-36-decimals' };
  if (valuation.missingMints.length) issues.push('missing-price-reference');
  return { address: input.address,owner,market: input.marketAddress,kind: input.kind,balances,valuation,issues,
    lpHolding: ['ylp','base_hlp','quote_hlp'].includes(input.kind) ? unsigned(state.amount,U64).toString() : null,
    hlpNav: hlpNav ? { signedVaultNav: hlpNav.signedVaultNav,quantityDecimals: hlpNav.quantityDecimals,underwater: hlpNav.underwater } : null,
    sourceSlot: input.slot.toString(),sourceTime: input.blockTime,basis: input.kind.includes('hlp') ? 'hlp-principal-nav.v1' : 'program-position-value.v1' };
}

export function totalPortfolioComponents(components: ReturnType<typeof projectPortfolioComponent>[]) {
  let assets = 0n,debt = 0n,knownNet = 0n,missing = 0;
  for (const component of components) {
    if (component.valuation.netUsd === null) { missing++; continue; }
    assets += usdUnits(component.valuation.assetsUsd!); debt += usdUnits(component.valuation.debtUsd!); knownNet += usdUnits(component.valuation.netUsd);
  }
  return { assetsUsd: missing ? null : formatUsd(assets),debtUsd: missing ? null : formatUsd(debt),netPositionValueUsd: missing ? null : formatUsd(knownNet),
    knownNetSubtotalUsd: formatUsd(knownNet),unvaluedComponents: missing,
    quality: missing ? 'incomplete' : components.length ? 'reference-valued' : 'empty',includesWalletBalances: false,includesUnclaimedYield: false };
}
