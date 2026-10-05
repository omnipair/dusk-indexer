import { cache } from '../utils/cache';
import { listTrailingYlpRate, TrailingYlpMarket, TrailingYlpRate } from './duskYieldRates';

/** v1 annualizes LP APR over a fixed seven-day window and caches it for five
 * minutes (omnipair-indexer `calculateAPR`); hLP rates follow the same cadence. */
export const HLP_RATE_WINDOW_MS = 7 * 86400_000;
const HLP_RATE_CACHE_MS = 5 * 60_000;
const NAD = 1_000_000_000n;
const BPS = 10_000n;

type Side = 'base' | 'quote';
type Amount = string | null | undefined;

export interface HlpVaultRateInput {
  side: Side;
  baseDecimals: number;
  quoteDecimals: number;
  targetLeverageBps: number;
  vault: { hlpSupply: string; mintSupply: string; lastNavNad: string;
    fundingAprEmaNad: string; fundingAprEmaLastSlot: string };
  /** The market preview's post-update state; `null` values are unknown. */
  state: Partial<Record<'baseHlpFundingDebt' | 'quoteHlpFundingDebt' | 'baseSpotPriceNad' | 'quoteSpotPriceNad'
    | 'baseBorrowAprNad' | 'quoteBorrowAprNad', Amount>>;
  /** The market's recorded yLP rates; `undefined` when they could not be read. */
  ylp: TrailingYlpRate | undefined;
  windowMs: number;
}

export interface HlpVaultRates {
  schemaVersion: 'dusk-hlp-rates.v1';
  basis: 'leveraged-recorded-ylp-net-of-funding.v1';
  windowSeconds: number;
  /** Gross yLP exposure per unit of equity. `vault` is the vault's own
   * inventory; `target` is the configured leverage a first deposit opens at. */
  leverageBps: string;
  leverageBasis: 'vault' | 'target';
  /** `ema` is the vault's twelve-hour funding average; `current` is the
   * borrowed asset's borrow rate for a vault that has not paid funding yet. */
  fundingBasis: 'ema' | 'current';
  ylpGrowth: 'recorded' | 'none' | 'unknown';
  swapRatePct: string | null;
  interestRatePct: string | null;
  fundingRatePct: string | null;
  netRatePct: string | null;
}

function amount(value: Amount): bigint | null {
  return typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value) ? BigInt(value) : null;
}

function percent(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) return null;
  const fixed = value.toFixed(8).replace(/\.?0+$/, '');
  return fixed === '-0' ? '0' : fixed;
}

/**
 * One hLP vault's net rate, from its live composition and the market's
 * recorded yLP growth. The vault holds ordinary yLP worth `L` times its
 * equity, so it earns `L` times the yLP swap and interest rates, and pays the
 * funding rate on debt worth `L - 1` times its equity (earn-hlp docs: "the net
 * yield subtracts it from the fee yield the vault's yLP has earned").
 * Debt is valued with the preview's spot price, the price the program uses
 * for the vault's NAV.
 */
export function projectHlpVaultRates(input: HlpVaultRateInput): HlpVaultRates {
  const opposite: Side = input.side === 'base' ? 'quote' : 'base';
  const scale = BigInt(Math.max(9, input.baseDecimals, input.quoteDecimals));
  const oppositeDecimals = BigInt(opposite === 'base' ? input.baseDecimals : input.quoteDecimals);
  const supply = amount(input.vault.hlpSupply), mintSupply = amount(input.vault.mintSupply);
  const nav = amount(input.vault.lastNavNad);
  const debt = amount(input.state[`${opposite}HlpFundingDebt`]);
  const price = amount(input.state[`${opposite}SpotPriceNad`]);
  // An empty vault opens at its target leverage. A held vault is valued from
  // its own inventory; an unreconciled one (external burns) is not valued.
  const empty = supply === 0n;
  const leverageBasis: HlpVaultRates['leverageBasis'] = empty ? 'target' : 'vault';
  const leverageBps = empty ? BigInt(input.targetLeverageBps)
    : supply === null || supply !== mintSupply || nav === null || nav === 0n || debt === null || price === null ? null
      : (nav + debt * 10n ** (scale - oppositeDecimals) * price / NAD) * BPS / nav;
  const emaSlot = amount(input.vault.fundingAprEmaLastSlot);
  const fundingBasis: HlpVaultRates['fundingBasis'] = emaSlot !== null && emaSlot > 0n ? 'ema' : 'current';
  const fundingAprNad = fundingBasis === 'ema'
    ? amount(input.vault.fundingAprEmaNad) : amount(input.state[`${opposite}BorrowAprNad`]);
  const leverage = leverageBps === null ? null : Number(leverageBps) / Number(BPS);
  const ylpRate = (value: string | null | undefined) => {
    if (leverage === null || value === null || value === undefined) return null;
    return Number(value) * leverage;
  };
  const swap = ylpRate(input.ylp?.swapRatePct), interest = ylpRate(input.ylp?.interestRatePct);
  const funding = leverage === null || fundingAprNad === null
    ? null : -(leverage - 1) * (Number(fundingAprNad) / Number(NAD)) * 100;
  return {
    schemaVersion: 'dusk-hlp-rates.v1',
    basis: 'leveraged-recorded-ylp-net-of-funding.v1',
    windowSeconds: input.windowMs / 1000,
    leverageBps: leverageBps === null ? '0' : leverageBps.toString(),
    leverageBasis,
    fundingBasis,
    ylpGrowth: input.ylp?.growth ?? 'unknown',
    swapRatePct: percent(swap),
    interestRatePct: percent(interest),
    fundingRatePct: percent(funding),
    netRatePct: swap === null || interest === null || funding === null ? null : percent(swap + interest + funding),
  };
}

/** One market's recorded yLP rates, shared by every payload of that market. */
export function trailingYlpRate(deploymentIdentitySha256: string, market: TrailingYlpMarket): Promise<TrailingYlpRate> {
  return cache.getOrSet(`dusk:trailing_ylp_rate:${deploymentIdentitySha256}:${market.market}`, HLP_RATE_CACHE_MS,
    () => listTrailingYlpRate({ deploymentIdentitySha256, until: Date.now(), windowMs: HLP_RATE_WINDOW_MS, market }));
}

/** Adds `rates` to both hLP vaults of a projected market payload. A failed
 * rate read leaves the rates `null`; it never withholds the vault state. */
export async function withHlpRates(payload: Record<string, unknown>, deploymentIdentitySha256: string,
  read: typeof trailingYlpRate = trailingYlpRate): Promise<Record<string, unknown>> {
  const hlp = payload.hlp as Record<Side, HlpVaultRateInput['vault'] & Record<string, unknown>> | null | undefined;
  if (!hlp) return payload;
  let ylp: TrailingYlpRate | null = null;
  try {
    ylp = await read(deploymentIdentitySha256, {
      market: String(payload.marketAddress), ylpMint: String(payload.ylpMint),
      baseMint: String(payload.baseMint), quoteMint: String(payload.quoteMint),
      baseDecimals: Number(payload.baseDecimals), quoteDecimals: Number(payload.quoteDecimals),
    });
  } catch (error) { console.warn('hLP rate read failed', error instanceof Error ? error.message : error); }
  const rates = (side: Side) => ylp === null ? null : projectHlpVaultRates({
    side,
    baseDecimals: Number(payload.baseDecimals),
    quoteDecimals: Number(payload.quoteDecimals),
    targetLeverageBps: Number(payload.targetHlpLeverageBps),
    vault: hlp[side],
    state: payload.state as HlpVaultRateInput['state'],
    ylp,
    windowMs: HLP_RATE_WINDOW_MS,
  });
  return { ...payload, hlp: { ...hlp, base: { ...hlp.base, rates: rates('base') }, quote: { ...hlp.quote, rates: rates('quote') } } };
}
