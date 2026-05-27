export const MINIMUM_LIQUIDITY = 1000;
export const HOUR_MS = 60 * 60 * 1000;

export type SnapshotQuality = 'exact' | 'estimated';
export type PriceQuality = 'historical' | 'current' | 'estimated' | 'missing';
export type LpEarningSource = 'borrow_interest' | 'swap_fee';
export type AllocationQuality = 'exact' | 'estimated';

export interface TokenPrice {
  priceUsd: number;
  decimals: number;
  quality: PriceQuality;
}

export interface LiquiditySupplyEvent {
  slot: number;
  liquidity: number;
  eventType: 'add' | 'remove' | 'mint' | 'burn' | string;
}

export interface ActiveLpPosition {
  signer: string;
  lpAmount: number;
}

export interface LpEarningAllocation {
  signer: string;
  lpAmount: number;
  totalSupply: number;
  lpShare: number;
  token0Amount: number;
  token1Amount: number;
  token0Usd: number;
  token1Usd: number;
  totalUsd: number;
  priceQuality: PriceQuality;
}

export function floorToHour(value: Date): Date {
  return new Date(Math.floor(value.getTime() / HOUR_MS) * HOUR_MS);
}

export function parseNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : fallback;
  }
  if (typeof value === 'bigint') {
    return Number(value);
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

export function tokenRawToUsd(rawAmount: unknown, price: TokenPrice | null | undefined): number {
  if (!price || price.priceUsd <= 0) {
    return 0;
  }
  return parseNumber(rawAmount) / Math.pow(10, price.decimals) * price.priceUsd;
}

export function sumTokenValueUsd(
  token0Amount: unknown,
  token1Amount: unknown,
  token0Price: TokenPrice | null | undefined,
  token1Price: TokenPrice | null | undefined
): number {
  return tokenRawToUsd(token0Amount, token0Price) + tokenRawToUsd(token1Amount, token1Price);
}

function priceQualityForAmount(
  rawAmount: unknown,
  price: TokenPrice | null | undefined
): PriceQuality | null {
  if (Math.abs(parseNumber(rawAmount)) === 0) {
    return null;
  }
  if (!price || price.priceUsd <= 0) {
    return 'missing';
  }
  return price.quality;
}

export function amountAwarePriceQuality(
  token0Amount: unknown,
  token1Amount: unknown,
  token0Price: TokenPrice | null | undefined,
  token1Price: TokenPrice | null | undefined
): PriceQuality {
  const qualities = [
    priceQualityForAmount(token0Amount, token0Price),
    priceQualityForAmount(token1Amount, token1Price),
  ].filter((quality): quality is PriceQuality => quality !== null);

  if (qualities.length === 0) {
    return 'historical';
  }
  if (qualities.includes('missing')) {
    return 'missing';
  }
  if (qualities.includes('estimated')) {
    return 'estimated';
  }
  if (qualities.includes('current')) {
    return 'current';
  }
  return 'historical';
}

export function reconstructTotalSupplyAtSlot(events: LiquiditySupplyEvent[], slot: number): number {
  return events.reduce((totalSupply, event) => {
    if (event.slot > slot) {
      return totalSupply;
    }
    const liquidity = parseNumber(event.liquidity);
    if (event.eventType === 'remove' || event.eventType === 'burn') {
      return totalSupply - liquidity;
    }
    return totalSupply + liquidity;
  }, MINIMUM_LIQUIDITY);
}

export function allocateLpEarning(
  activePositions: ActiveLpPosition[],
  totalSupply: number,
  token0Amount: number,
  token1Amount: number,
  token0Price: TokenPrice | null | undefined,
  token1Price: TokenPrice | null | undefined
): LpEarningAllocation[] {
  if (totalSupply <= 0) {
    return [];
  }

  return activePositions
    .filter((position) => position.lpAmount > 0)
    .map((position) => {
      const lpShare = position.lpAmount / totalSupply;
      const allocatedToken0 = token0Amount * lpShare;
      const allocatedToken1 = token1Amount * lpShare;
      const token0Usd = tokenRawToUsd(allocatedToken0, token0Price);
      const token1Usd = tokenRawToUsd(allocatedToken1, token1Price);
      const priceQuality = amountAwarePriceQuality(
        allocatedToken0,
        allocatedToken1,
        token0Price,
        token1Price
      );

      return {
        signer: position.signer,
        lpAmount: position.lpAmount,
        totalSupply,
        lpShare,
        token0Amount: allocatedToken0,
        token1Amount: allocatedToken1,
        token0Usd,
        token1Usd,
        totalUsd: token0Usd + token1Usd,
        priceQuality,
      };
    });
}

export function calculateValueDeltaUsd(currentValueUsd: number, netContributedUsd: number): number {
  return currentValueUsd - netContributedUsd;
}
