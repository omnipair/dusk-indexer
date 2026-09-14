import { DuskPinnedProtocol } from '../config/duskProtocol';
import { priceMarketBindings } from './duskPriceMath';
import { formatUsd, nativeFields, nativeKey, usdUnits } from './duskPortfolioMath';
import { unsigned } from './duskYieldAccounting';

const U64 = (1n << 64n)-1n, U128 = (1n << 128n)-1n, Q64 = 1n << 64n, SCALE = 10n ** 36n;
const YEAR_SECONDS = 365n * 24n * 60n * 60n;
export interface YieldRatePrice { mint: string; decimals: number; priceUsd: string; quality: string }
export interface MarketGrowthPoint {
  market: string; lpMint: string; slot: number; blockTime: string; deploymentIdentitySha256: string;
  basis: 'committed-market-growth.v1'; supply: string;
  assets: Array<{ mint: string; decimals: number; reserve: string; swapIndexQ64: string; interestIndexQ64: string }>;
}

/** Decode committed account bytes, never PreviewMarket's hypothetical post-state.
 * A growth index is an entitlement per raw yLP share, independent of a holder's
 * balance, claims, deposits or transfers during the observation interval. */
export function marketGrowthPoint(input: {
  pin: DuskPinnedProtocol; marketAddress: string; market: unknown;
  slot: number; blockTime: string; deploymentIdentitySha256: string;
}): MarketGrowthPoint {
  const market = nativeFields(input.market);
  priceMarketBindings(input.pin.dusk.programId,input.marketAddress,market);
  if (!Number.isSafeInteger(input.slot) || input.slot<input.pin.historyFirstSlot
    || !Number.isFinite(Date.parse(input.blockTime)) || !/^[0-9a-f]{64}$/.test(input.deploymentIdentitySha256)
    || unsigned(market.version,255n) !== 1n) throw new Error('Invalid committed market growth provenance');
  let supply: bigint | null = null;
  const assets = ['base','quote'].map((name) => {
    const side = nativeFields(market[`${name}_side`]),fees = nativeFields(side.fees);
    const currentSupply = unsigned(nativeFields(side.shares).ylp_supply,U64);
    if (supply !== null && supply !== currentSupply) throw new Error('Market growth share ledgers disagree');
    supply = currentSupply;
    return { mint: nativeKey(side.asset_mint),decimals: Number(unsigned(side.asset_decimals,255n)),
      reserve: unsigned(nativeFields(side.reserves).live_reserve,U64).toString(),
      swapIndexQ64: unsigned(fees.swap_fee_growth_index_q64,U128).toString(),
      interestIndexQ64: unsigned(fees.interest_growth_index_q64,U128).toString() };
  });
  return { market: input.marketAddress,lpMint: nativeKey(market.ylp_mint),slot: input.slot,
    blockTime: new Date(input.blockTime).toISOString(),deploymentIdentitySha256: input.deploymentIdentitySha256,
    basis: 'committed-market-growth.v1',supply: supply!.toString(),assets };
}

/** Simple annualization of recorded, claimable LP earnings, valued at the end
 * prices against starting native share value. Unpaid interest and compounded
 * principal are separate lanes and are never inferred from these indexes. */
export function recordedYlpRates(input: {
  start: MarketGrowthPoint; end: MarketGrowthPoint;
  startPrices: YieldRatePrice[]; endPrices: YieldRatePrice[];
}) {
  const { start,end } = input;
  const elapsedMilliseconds = Date.parse(end.blockTime)-Date.parse(start.blockTime);
  if (start.market !== end.market || start.lpMint !== end.lpMint || start.slot>=end.slot
    || start.basis !== 'committed-market-growth.v1' || end.basis !== start.basis
    || !Number.isSafeInteger(elapsedMilliseconds) || elapsedMilliseconds<=0
    || start.assets.length !== 2 || end.assets.length !== 2)
    throw new Error('Incompatible recorded yield window');
  // The caller must verify each historical deployment against the same full
  // pinned release. Replica/build hashes may differ without resetting indexes.
  const supply = unsigned(start.supply,U64);
  const missing = new Set<string>();
  let capital = 0n,swap = 0n,interest = 0n;
  const deltas = start.assets.map((asset,index) => {
    const last = end.assets[index];
    if (asset.mint !== last.mint || asset.decimals !== last.decimals
      || !Number.isInteger(asset.decimals) || asset.decimals<0 || asset.decimals>255)
      throw new Error('Market growth mint or precision changed');
    const swapDelta = unsigned(last.swapIndexQ64,U128)-unsigned(asset.swapIndexQ64,U128);
    const interestDelta = unsigned(last.interestIndexQ64,U128)-unsigned(asset.interestIndexQ64,U128);
    if (swapDelta<0n || interestDelta<0n) throw new Error('Committed yield index regressed');
    const initial = input.startPrices.find((price) => price.mint === asset.mint);
    const final = input.endPrices.find((price) => price.mint === asset.mint);
    for (const price of [initial,final]) {
      if (price && (price.decimals !== asset.decimals || usdUnits(price.priceUsd)<=0n))
        throw new Error('Yield price differs from native mint precision');
    }
    const reserve = unsigned(asset.reserve,U64),precision = 10n**BigInt(asset.decimals);
    if (reserve>0n && !initial) missing.add(asset.mint);
    if ((swapDelta>0n || interestDelta>0n) && !final) missing.add(asset.mint);
    if (initial) capital += reserve*usdUnits(initial.priceUsd)/precision;
    if (final) {
      swap += swapDelta*usdUnits(final.priceUsd)*SCALE/precision;
      interest += interestDelta*usdUnits(final.priceUsd)*SCALE/precision;
    }
    return { mint: asset.mint,decimals: asset.decimals,swapIndexDeltaQ64: swapDelta.toString(),interestIndexDeltaQ64: interestDelta.toString() };
  });
  const available = missing.size === 0 && capital>0n && supply>0n;
  const annualize = (value: bigint) => available
    ? formatUsd(value*supply*YEAR_SECONDS*100_000n/(Q64*capital*BigInt(elapsedMilliseconds))) : null;
  return {
    basis: 'recorded-claimable-ylp-rate.v1' as const,
    annualization: 'simple-365-day' as const,valuation: 'end-price-over-start-share-value' as const,
    swapRatePct: annualize(swap),interestRatePct: annualize(interest),claimableRatePct: annualize(swap+interest),
    startingCapitalUsd: missing.size ? null : formatUsd(capital),startingSupply: supply.toString(),
    elapsedMilliseconds,missingMints: [...missing].sort(),deltas,
    unpaidInterestIncluded: false as const,compoundedPrincipalIncluded: false as const,
  };
}
