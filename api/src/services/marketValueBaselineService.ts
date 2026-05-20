import { QueryResult, QueryResultRow } from 'pg';

export const MARKET_VALUE_BASELINE_RANGES = ['1H', '2H', '4H', '12H', '24H', '7D'] as const;

export type MarketValueBaselineRange = typeof MARKET_VALUE_BASELINE_RANGES[number];
export type MarketValueBaselineVisibility = 'visible' | 'all';
export type BaselineQuality = 'exact' | 'estimated' | 'missing';
export type BaselinePriceQuality = 'historical' | 'current' | 'estimated' | 'missing' | 'mixed';

export interface Queryable {
  query<T extends QueryResultRow = any>(text: string, params?: any[]): Promise<QueryResult<T>>;
}

export interface MetricBaseline {
  value: number | null;
  quality: BaselineQuality;
  source?: string;
  timestamp?: string | null;
  priceQuality?: BaselinePriceQuality;
  priceTimestamp?: string | null;
}

export interface PairMetricBaseline {
  token0: MetricBaseline;
  token1: MetricBaseline;
}

export interface PoolValueBaselines {
  pairAddress: string;
  token0: string;
  token1: string;
  metrics: {
    tvlUsd: MetricBaseline;
    virtualLiquidityUsd: MetricBaseline;
    totalDebtUsd: MetricBaseline;
    volume24hUsd: MetricBaseline;
    totalFeesUsd: MetricBaseline;
    apr: MetricBaseline;
    borrowRates: PairMetricBaseline;
    utilization: PairMetricBaseline;
    reserves: PairMetricBaseline;
    cashReserves: PairMetricBaseline;
  };
}

export interface TokenValueBaselines {
  mint: string;
  metrics: {
    priceUsd: MetricBaseline;
    liquidityUsd: MetricBaseline;
    debtUsd: MetricBaseline;
    borrowRate: MetricBaseline;
    utilization: MetricBaseline;
  };
}

export interface MarketValueBaselinesResponse {
  range: MarketValueBaselineRange;
  windowHours: number;
  generatedAt: string;
  baselineAt: string;
  priceProvider: 'token_price_snapshots';
  pools: Record<string, PoolValueBaselines>;
  tokens: Record<string, TokenValueBaselines>;
  protocol: {
    metrics: {
      totalDepositedUsd: MetricBaseline;
      totalVolumeUsd: MetricBaseline;
      totalBorrowedUsd: MetricBaseline;
      totalFeesUsd: MetricBaseline;
      poolCount: MetricBaseline;
    };
  };
}

interface PoolRow {
  id: number;
  pair_address: string;
  token0: string;
  token1: string;
}

interface PriceRow {
  mint: string;
  bucket: Date | string;
  price_usd: string;
  decimals: number | null;
  provider: string;
  quality: BaselinePriceQuality;
}

interface StoredPrice {
  mint: string;
  bucket: Date;
  priceUsd: number;
  decimals: number;
  provider: string;
  quality: BaselinePriceQuality;
}

interface ReserveRow {
  pair: string;
  reserve0: string | null;
  reserve1: string | null;
  timestamp: Date | string | null;
  source: string;
}

interface PairStateRow {
  pair: string;
  rate0: string | null;
  rate1: string | null;
  cash_reserve0: string | null;
  cash_reserve1: string | null;
  timestamp: Date | string | null;
}

interface DebtRow {
  pair: string;
  debt0: string | null;
  debt1: string | null;
}

interface InterestDebtRow {
  pair: string;
  interest0: string | null;
  interest1: string | null;
}

interface UsdAggregateRow {
  pair: string;
  value_usd: string | null;
}

interface AprRow {
  pair: string;
  weekly_fee0?: string | null;
  weekly_fee1?: string | null;
  weekly_lp_interest0?: string | null;
  weekly_lp_interest1?: string | null;
  avg_reserve0?: string | null;
  avg_reserve1?: string | null;
}

interface CollateralRow {
  pair: string;
  collateral0: string | null;
  collateral1: string | null;
}

interface TokenAggregate {
  liquidityUsd: number;
  liquidityMissing: boolean;
  debtUsd: number;
  debtMissing: boolean;
  borrowRates: number[];
  borrowRateMissing: boolean;
  utilizations: number[];
  utilizationMissing: boolean;
}

interface ConversionResult {
  usd: number | null;
  human: number | null;
  quality: BaselineQuality;
  priceQuality: BaselinePriceQuality;
  priceTimestamp: string | null;
}

const RANGE_WINDOW_HOURS: Record<MarketValueBaselineRange, number> = {
  '1H': 1,
  '2H': 2,
  '4H': 4,
  '12H': 12,
  '24H': 24,
  '7D': 24 * 7,
};

const PRE_INDEX_TOTAL_FEES = 47396 * 0.0025;

export function normalizeMarketValueBaselineRange(
  range?: string | null
): { range: MarketValueBaselineRange; windowHours: number } {
  const normalized = (range || '2H').toUpperCase() as MarketValueBaselineRange;
  if (!MARKET_VALUE_BASELINE_RANGES.includes(normalized)) {
    throw new Error(`Unsupported range. Must be one of: ${MARKET_VALUE_BASELINE_RANGES.join(', ')}`);
  }

  return {
    range: normalized,
    windowHours: RANGE_WINDOW_HOURS[normalized],
  };
}

export async function getMarketValueBaselines(
  db: Queryable,
  options: {
    range?: string | null;
    visibility?: MarketValueBaselineVisibility;
    now?: Date;
  } = {}
): Promise<MarketValueBaselinesResponse> {
  const { range, windowHours } = normalizeMarketValueBaselineRange(options.range);
  const now = options.now ?? new Date();
  const baselineAt = new Date(now.getTime() - windowHours * 60 * 60 * 1000);
  const pools = await fetchPools(db, options.visibility ?? 'visible');
  const pairAddresses = pools.map((pool) => pool.pair_address);
  const mints = [...new Set(pools.flatMap((pool) => [pool.token0, pool.token1]).filter(Boolean))];

  const [
    prices,
    reserves,
    pairStates,
    principalDebts,
    interestDebts,
    volumes24h,
    totalFees,
    swapAprRows,
    interestAprRows,
    collateralRows,
    protocolVolume,
  ] = await Promise.all([
    fetchStoredPrices(db, mints, baselineAt),
    fetchLatestReserves(db, pairAddresses, baselineAt),
    fetchLatestPairStates(db, pairAddresses, baselineAt),
    fetchDebtPrincipal(db, pairAddresses, baselineAt),
    fetchAccruedDebtInterest(db, pairAddresses, baselineAt),
    fetchRolling24hVolume(db, pairAddresses, baselineAt),
    fetchTotalFees(db, pairAddresses, baselineAt),
    fetchSwapAprInputs(db, pairAddresses, baselineAt),
    fetchInterestAprInputs(db, pairAddresses, baselineAt),
    fetchCollateralDeposits(db, pairAddresses, baselineAt),
    fetchProtocolTotalVolume(db, pairAddresses, baselineAt),
  ]);

  const poolBaselines: Record<string, PoolValueBaselines> = {};
  const tokenAggregates = new Map<string, TokenAggregate>();

  let protocolVirtualLiquidityUsd = 0;
  let protocolVirtualLiquidityMissing = false;
  let protocolCollateralUsd = 0;
  let protocolCollateralMissing = false;
  let protocolDebtUsd = 0;
  let protocolDebtMissing = false;
  let protocolFeesUsd = PRE_INDEX_TOTAL_FEES;

  for (const poolRow of pools) {
    const pairAddress = poolRow.pair_address;
    const reserve = reserves.get(pairAddress);
    const pairState = pairStates.get(pairAddress);
    const principalDebt = principalDebts.get(pairAddress);
    const interestDebt = interestDebts.get(pairAddress);
    const debt0Raw = Math.max(0, parseNumber(principalDebt?.debt0) + parseNumber(interestDebt?.interest0));
    const debt1Raw = Math.max(0, parseNumber(principalDebt?.debt1) + parseNumber(interestDebt?.interest1));

    const reserve0 = convertRawToUsd(parseNumber(reserve?.reserve0), poolRow.token0, prices);
    const reserve1 = convertRawToUsd(parseNumber(reserve?.reserve1), poolRow.token1, prices);
    const cashReserve0 = convertRawToUsd(parseNumber(pairState?.cash_reserve0), poolRow.token0, prices);
    const cashReserve1 = convertRawToUsd(parseNumber(pairState?.cash_reserve1), poolRow.token1, prices);
    const debt0 = convertRawToUsd(debt0Raw, poolRow.token0, prices);
    const debt1 = convertRawToUsd(debt1Raw, poolRow.token1, prices);

    const reserveTimestamp = toIso(reserve?.timestamp);
    const pairStateTimestamp = toIso(pairState?.timestamp);
    const virtualLiquidityUsd = makeUsdMetric(
      [reserve0, reserve1],
      reserveTimestamp,
      reserve?.source ?? 'historical_reserve_state'
    );
    const tvlUsd = makeUsdMetric(
      [cashReserve0, cashReserve1],
      pairStateTimestamp,
      'update_pair_events'
    );
    const totalDebtUsd = makeUsdMetric(
      [debt0, debt1],
      baselineAt.toISOString(),
      'adjust_debt_events+update_pair_events',
      'estimated'
    );
    const volume24hUsd = exactNumberMetric(
      parseNumber(volumes24h.get(pairAddress)?.value_usd),
      baselineAt.toISOString(),
      'swaps.volume_usd'
    );
    const feesUsd = exactNumberMetric(
      parseNumber(totalFees.get(pairAddress)?.value_usd),
      baselineAt.toISOString(),
      'swaps.fee_usd'
    );
    const apr = calculateAprMetric(
      swapAprRows.get(pairAddress),
      interestAprRows.get(pairAddress),
      baselineAt
    );
    const borrowRates = {
      token0: rateMetric(pairState?.rate0, pairStateTimestamp),
      token1: rateMetric(pairState?.rate1, pairStateTimestamp),
    };
    const utilization = {
      token0: utilizationMetric(debt0Raw, parseNumber(reserve?.reserve0), reserveTimestamp),
      token1: utilizationMetric(debt1Raw, parseNumber(reserve?.reserve1), reserveTimestamp),
    };

    protocolVirtualLiquidityMissing ||= virtualLiquidityUsd.quality === 'missing';
    protocolVirtualLiquidityUsd += virtualLiquidityUsd.value ?? 0;
    protocolDebtMissing ||= totalDebtUsd.quality === 'missing';
    protocolDebtUsd += totalDebtUsd.value ?? 0;
    protocolFeesUsd += feesUsd.value ?? 0;

    const collateral = collateralRows.get(pairAddress);
    const collateral0 = convertRawToUsd(parseNumber(collateral?.collateral0), poolRow.token0, prices);
    const collateral1 = convertRawToUsd(parseNumber(collateral?.collateral1), poolRow.token1, prices);
    const collateralUsd = makeUsdMetric(
      [collateral0, collateral1],
      baselineAt.toISOString(),
      'user_position_updated_events',
      'estimated'
    );
    protocolCollateralMissing ||= collateralUsd.quality === 'missing';
    protocolCollateralUsd += collateralUsd.value ?? 0;

    addTokenAggregate(tokenAggregates, poolRow.token0, {
      liquidity: reserve0,
      debt: debt0,
      borrowRate: borrowRates.token0,
      utilization: utilization.token0,
    });
    addTokenAggregate(tokenAggregates, poolRow.token1, {
      liquidity: reserve1,
      debt: debt1,
      borrowRate: borrowRates.token1,
      utilization: utilization.token1,
    });

    poolBaselines[pairAddress] = {
      pairAddress,
      token0: poolRow.token0,
      token1: poolRow.token1,
      metrics: {
        tvlUsd,
        virtualLiquidityUsd,
        totalDebtUsd,
        volume24hUsd,
        totalFeesUsd: feesUsd,
        apr,
        borrowRates,
        utilization,
        reserves: {
          token0: amountMetric(reserve0, reserveTimestamp, reserve?.source ?? 'historical_reserve_state'),
          token1: amountMetric(reserve1, reserveTimestamp, reserve?.source ?? 'historical_reserve_state'),
        },
        cashReserves: {
          token0: amountMetric(cashReserve0, pairStateTimestamp, 'update_pair_events'),
          token1: amountMetric(cashReserve1, pairStateTimestamp, 'update_pair_events'),
        },
      },
    };
  }

  const tokenBaselines = buildTokenBaselines(mints, prices, tokenAggregates);
  const totalDepositedMissing = protocolVirtualLiquidityMissing || protocolCollateralMissing;

  return {
    range,
    windowHours,
    generatedAt: now.toISOString(),
    baselineAt: baselineAt.toISOString(),
    priceProvider: 'token_price_snapshots',
    pools: poolBaselines,
    tokens: tokenBaselines,
    protocol: {
      metrics: {
        totalDepositedUsd: totalDepositedMissing
          ? missingMetric('historical_deposits', baselineAt.toISOString())
          : estimatedNumberMetric(protocolVirtualLiquidityUsd + protocolCollateralUsd, baselineAt.toISOString(), 'historical_deposits'),
        totalVolumeUsd: exactNumberMetric(protocolVolume, baselineAt.toISOString(), 'swaps.volume_usd'),
        totalBorrowedUsd: protocolDebtMissing
          ? missingMetric('historical_debt', baselineAt.toISOString())
          : estimatedNumberMetric(protocolDebtUsd, baselineAt.toISOString(), 'historical_debt'),
        totalFeesUsd: exactNumberMetric(protocolFeesUsd, baselineAt.toISOString(), 'swaps.fee_usd'),
        poolCount: missingMetric('pools.created_at_unavailable', baselineAt.toISOString()),
      },
    },
  };
}

async function fetchPools(db: Queryable, visibility: MarketValueBaselineVisibility): Promise<PoolRow[]> {
  const visibilityClause = visibility === 'all' ? '' : 'WHERE visible = TRUE';
  const result = await db.query<PoolRow>(
    `
      SELECT id, pair_address, token0, token1
      FROM pools
      ${visibilityClause}
      ORDER BY id ASC
    `
  );
  return result.rows;
}

async function fetchStoredPrices(
  db: Queryable,
  mints: string[],
  baselineAt: Date
): Promise<Map<string, StoredPrice>> {
  if (mints.length === 0) {
    return new Map();
  }

  const result = await db.query<PriceRow>(
    `
      SELECT mint, bucket, price_usd, decimals, provider, quality
      FROM (
        SELECT
          mint,
          bucket,
          price_usd,
          decimals,
          provider,
          quality,
          ROW_NUMBER() OVER (PARTITION BY mint ORDER BY bucket DESC) AS rn
        FROM token_price_snapshots
        WHERE mint = ANY($1::text[])
          AND bucket <= date_trunc('hour', $2::timestamptz)
          AND provider = 'birdeye'
      ) ranked
      WHERE rn = 1
    `,
    [mints, baselineAt]
  );

  const prices = new Map<string, StoredPrice>();
  for (const row of result.rows) {
    prices.set(row.mint, {
      mint: row.mint,
      bucket: new Date(row.bucket),
      priceUsd: parseNumber(row.price_usd),
      decimals: row.decimals ?? 6,
      provider: row.provider,
      quality: row.quality,
    });
  }
  return prices;
}

async function fetchLatestReserves(
  db: Queryable,
  pairAddresses: string[],
  baselineAt: Date
): Promise<Map<string, ReserveRow>> {
  if (pairAddresses.length === 0) {
    return new Map();
  }

  const result = await db.query<ReserveRow>(
    `
      SELECT DISTINCT ON (pair)
        pair,
        reserve0::text,
        reserve1::text,
        timestamp,
        source
      FROM (
        SELECT
          pair,
          reserve0,
          reserve1,
          timestamp,
          slot,
          'swaps' AS source
        FROM swaps
        WHERE pair = ANY($1::text[])
          AND timestamp <= $2
        UNION ALL
        SELECT
          pair,
          reserve0_after_interest AS reserve0,
          reserve1_after_interest AS reserve1,
          timestamp,
          slot,
          'update_pair_events' AS source
        FROM update_pair_events
        WHERE pair = ANY($1::text[])
          AND timestamp <= $2
      ) events
      ORDER BY pair, timestamp DESC, slot DESC
    `,
    [pairAddresses, baselineAt]
  );

  return rowsByPair(result.rows);
}

async function fetchLatestPairStates(
  db: Queryable,
  pairAddresses: string[],
  baselineAt: Date
): Promise<Map<string, PairStateRow>> {
  if (pairAddresses.length === 0) {
    return new Map();
  }

  const result = await db.query<PairStateRow>(
    `
      SELECT DISTINCT ON (pair)
        pair,
        rate0::text,
        rate1::text,
        cash_reserve0::text,
        cash_reserve1::text,
        timestamp
      FROM update_pair_events
      WHERE pair = ANY($1::text[])
        AND timestamp <= $2
      ORDER BY pair, timestamp DESC, slot DESC
    `,
    [pairAddresses, baselineAt]
  );

  return rowsByPair(result.rows);
}

async function fetchDebtPrincipal(
  db: Queryable,
  pairAddresses: string[],
  baselineAt: Date
): Promise<Map<string, DebtRow>> {
  if (pairAddresses.length === 0) {
    return new Map();
  }

  const result = await db.query<DebtRow>(
    `
      SELECT
        pair,
        GREATEST(COALESCE(SUM(amount0::numeric), 0), 0)::text AS debt0,
        GREATEST(COALESCE(SUM(amount1::numeric), 0), 0)::text AS debt1
      FROM adjust_debt_events
      WHERE pair = ANY($1::text[])
        AND event_timestamp <= $2
      GROUP BY pair
    `,
    [pairAddresses, baselineAt]
  );

  return rowsByPair(result.rows);
}

async function fetchAccruedDebtInterest(
  db: Queryable,
  pairAddresses: string[],
  baselineAt: Date
): Promise<Map<string, InterestDebtRow>> {
  if (pairAddresses.length === 0) {
    return new Map();
  }

  const result = await db.query<InterestDebtRow>(
    `
      SELECT
        pair,
        COALESCE(SUM(accrued_interest0::numeric), 0)::text AS interest0,
        COALESCE(SUM(accrued_interest1::numeric), 0)::text AS interest1
      FROM update_pair_events
      WHERE pair = ANY($1::text[])
        AND timestamp <= $2
      GROUP BY pair
    `,
    [pairAddresses, baselineAt]
  );

  return rowsByPair(result.rows);
}

async function fetchRolling24hVolume(
  db: Queryable,
  pairAddresses: string[],
  baselineAt: Date
): Promise<Map<string, UsdAggregateRow>> {
  if (pairAddresses.length === 0) {
    return new Map();
  }

  const result = await db.query<UsdAggregateRow>(
    `
      SELECT
        pair,
        COALESCE(SUM(volume_usd), 0)::text AS value_usd
      FROM swaps
      WHERE pair = ANY($1::text[])
        AND timestamp > $2::timestamptz - interval '24 hours'
        AND timestamp <= $2
      GROUP BY pair
    `,
    [pairAddresses, baselineAt]
  );

  return rowsByPair(result.rows);
}

async function fetchTotalFees(
  db: Queryable,
  pairAddresses: string[],
  baselineAt: Date
): Promise<Map<string, UsdAggregateRow>> {
  if (pairAddresses.length === 0) {
    return new Map();
  }

  const result = await db.query<UsdAggregateRow>(
    `
      SELECT
        pair,
        COALESCE(SUM(COALESCE(lp_fee_usd, 0) + COALESCE(protocol_fee_usd, 0)), 0)::text AS value_usd
      FROM swaps
      WHERE pair = ANY($1::text[])
        AND timestamp <= $2
      GROUP BY pair
    `,
    [pairAddresses, baselineAt]
  );

  return rowsByPair(result.rows);
}

async function fetchSwapAprInputs(
  db: Queryable,
  pairAddresses: string[],
  baselineAt: Date
): Promise<Map<string, AprRow>> {
  if (pairAddresses.length === 0) {
    return new Map();
  }

  const result = await db.query<AprRow>(
    `
      SELECT
        pair,
        COALESCE(SUM(fee_paid0::numeric), 0)::text AS weekly_fee0,
        COALESCE(SUM(fee_paid1::numeric), 0)::text AS weekly_fee1,
        COALESCE(AVG(NULLIF(reserve0::numeric, 0)), 0)::text AS avg_reserve0,
        COALESCE(AVG(NULLIF(reserve1::numeric, 0)), 0)::text AS avg_reserve1
      FROM swaps
      WHERE pair = ANY($1::text[])
        AND timestamp > $2::timestamptz - interval '7 days'
        AND timestamp <= $2
      GROUP BY pair
    `,
    [pairAddresses, baselineAt]
  );

  return rowsByPair(result.rows);
}

async function fetchInterestAprInputs(
  db: Queryable,
  pairAddresses: string[],
  baselineAt: Date
): Promise<Map<string, AprRow>> {
  if (pairAddresses.length === 0) {
    return new Map();
  }

  const result = await db.query<AprRow>(
    `
      SELECT
        pair,
        COALESCE(SUM(lp_interest0::numeric), 0)::text AS weekly_lp_interest0,
        COALESCE(SUM(lp_interest1::numeric), 0)::text AS weekly_lp_interest1,
        COALESCE(AVG(NULLIF(reserve0_after_interest::numeric, 0)), 0)::text AS avg_reserve0,
        COALESCE(AVG(NULLIF(reserve1_after_interest::numeric, 0)), 0)::text AS avg_reserve1
      FROM update_pair_events
      WHERE pair = ANY($1::text[])
        AND timestamp > $2::timestamptz - interval '7 days'
        AND timestamp <= $2
      GROUP BY pair
    `,
    [pairAddresses, baselineAt]
  );

  return rowsByPair(result.rows);
}

async function fetchCollateralDeposits(
  db: Queryable,
  pairAddresses: string[],
  baselineAt: Date
): Promise<Map<string, CollateralRow>> {
  if (pairAddresses.length === 0) {
    return new Map();
  }

  const result = await db.query<CollateralRow>(
    `
      SELECT
        latest.pair,
        COALESCE(SUM(latest.collateral0::numeric), 0)::text AS collateral0,
        COALESCE(SUM(latest.collateral1::numeric), 0)::text AS collateral1
      FROM (
        SELECT DISTINCT ON (events.pair, events.position)
          events.pair,
          events.position,
          events.collateral0,
          events.collateral1
        FROM user_position_updated_events events
        WHERE events.pair = ANY($1::text[])
          AND events.event_timestamp <= $2
        ORDER BY events.pair, events.position, events.slot DESC, events.event_timestamp DESC, events.id DESC
      ) latest
      GROUP BY latest.pair
    `,
    [pairAddresses, baselineAt]
  );

  return rowsByPair(result.rows);
}

async function fetchProtocolTotalVolume(
  db: Queryable,
  pairAddresses: string[],
  baselineAt: Date
): Promise<number> {
  if (pairAddresses.length === 0) {
    return 0;
  }

  const result = await db.query<{ total_volume_usd: string | null }>(
    `
      SELECT COALESCE(SUM(volume_usd), 0)::text AS total_volume_usd
      FROM swaps
      WHERE pair = ANY($1::text[])
        AND timestamp <= $2
    `,
    [pairAddresses, baselineAt]
  );

  return parseNumber(result.rows[0]?.total_volume_usd);
}

function rowsByPair<T extends { pair: string }>(rows: T[]): Map<string, T> {
  const map = new Map<string, T>();
  for (const row of rows) {
    map.set(row.pair, row);
  }
  return map;
}

function parseNumber(value: unknown): number {
  if (value === null || value === undefined || value === '') {
    return 0;
  }

  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toIso(value: Date | string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function convertRawToUsd(
  rawAmount: number,
  mint: string,
  prices: Map<string, StoredPrice>
): ConversionResult {
  const price = prices.get(mint);
  const isZero = rawAmount === 0;

  if (!price || price.quality === 'missing' || price.priceUsd <= 0) {
    return {
      usd: isZero ? 0 : null,
      human: isZero ? 0 : null,
      quality: isZero ? 'exact' : 'missing',
      priceQuality: 'missing',
      priceTimestamp: null,
    };
  }

  const human = rawAmount / Math.pow(10, price.decimals);
  return {
    usd: human * price.priceUsd,
    human,
    quality: price.quality === 'estimated' || price.quality === 'current' ? 'estimated' : 'exact',
    priceQuality: price.quality,
    priceTimestamp: price.bucket.toISOString(),
  };
}

function makeUsdMetric(
  conversions: ConversionResult[],
  timestamp: string | null,
  source: string,
  forcedQuality?: BaselineQuality
): MetricBaseline {
  if (conversions.some((conversion) => conversion.quality === 'missing')) {
    return missingMetric(source, timestamp);
  }

  const value = conversions.reduce((sum, conversion) => sum + (conversion.usd ?? 0), 0);
  const priceQuality = mergePriceQualities(conversions.map((conversion) => conversion.priceQuality));
  const priceTimestamp = mergeTimestamps(conversions.map((conversion) => conversion.priceTimestamp));
  const quality = forcedQuality ?? (conversions.some((conversion) => conversion.quality === 'estimated') ? 'estimated' : 'exact');

  return {
    value,
    quality,
    source,
    timestamp,
    priceQuality,
    priceTimestamp,
  };
}

function amountMetric(conversion: ConversionResult, timestamp: string | null, source: string): MetricBaseline {
  if (conversion.quality === 'missing' || conversion.human === null) {
    return missingMetric(source, timestamp);
  }

  return {
    value: conversion.human,
    quality: conversion.quality,
    source,
    timestamp,
    priceQuality: conversion.priceQuality,
    priceTimestamp: conversion.priceTimestamp,
  };
}

function exactNumberMetric(value: number, timestamp: string | null, source: string): MetricBaseline {
  return {
    value,
    quality: 'exact',
    source,
    timestamp,
  };
}

function estimatedNumberMetric(value: number, timestamp: string | null, source: string): MetricBaseline {
  return {
    value,
    quality: 'estimated',
    source,
    timestamp,
  };
}

function missingMetric(source: string, timestamp: string | null): MetricBaseline {
  return {
    value: null,
    quality: 'missing',
    source,
    timestamp,
    priceQuality: 'missing',
  };
}

function rateMetric(rawRate: string | null | undefined, timestamp: string | null): MetricBaseline {
  if (rawRate === null || rawRate === undefined) {
    return missingMetric('update_pair_events.rate', timestamp);
  }

  const parsed = parseNumber(rawRate);
  const rate = parsed > 1000 ? Math.floor((parsed / 1e7) * 100) / 100 : parsed;
  return estimatedNumberMetric(Math.max(rate, 1), timestamp, 'update_pair_events.rate');
}

function utilizationMetric(debtRaw: number, reserveRaw: number, timestamp: string | null): MetricBaseline {
  if (reserveRaw <= 0) {
    return missingMetric('historical_utilization', timestamp);
  }

  return estimatedNumberMetric((debtRaw / reserveRaw) * 100, timestamp, 'historical_utilization');
}

function calculateAprMetric(
  swapRow: AprRow | undefined,
  interestRow: AprRow | undefined,
  baselineAt: Date
): MetricBaseline {
  const swapFee0 = parseNumber(swapRow?.weekly_fee0);
  const swapFee1 = parseNumber(swapRow?.weekly_fee1);
  const swapReserve0 = parseNumber(swapRow?.avg_reserve0);
  const swapReserve1 = parseNumber(swapRow?.avg_reserve1);
  const swapToken0Apr = swapReserve0 > 0 ? ((swapFee0 / 7) / (swapReserve0 * 2)) * 365 * 100 : 0;
  const swapToken1Apr = swapReserve1 > 0 ? ((swapFee1 / 7) / (swapReserve1 * 2)) * 365 * 100 : 0;
  const swapApr = (swapToken0Apr + swapToken1Apr) / 2;

  const interest0 = parseNumber(interestRow?.weekly_lp_interest0);
  const interest1 = parseNumber(interestRow?.weekly_lp_interest1);
  const interestReserve0 = parseNumber(interestRow?.avg_reserve0);
  const interestReserve1 = parseNumber(interestRow?.avg_reserve1);
  const interestToken0Apr = interestReserve0 > 0 ? ((interest0 / 7) / (interestReserve0 * 2)) * 365 * 100 : 0;
  const interestToken1Apr = interestReserve1 > 0 ? ((interest1 / 7) / (interestReserve1 * 2)) * 365 * 100 : 0;
  const interestApr = interestToken0Apr + interestToken1Apr;

  return exactNumberMetric(swapApr + interestApr, baselineAt.toISOString(), 'swaps+update_pair_events.rolling_7d_apr');
}

function mergePriceQualities(qualities: BaselinePriceQuality[]): BaselinePriceQuality {
  const nonMissing = qualities.filter((quality) => quality !== 'missing');
  if (nonMissing.length === 0) {
    return 'missing';
  }
  const first = nonMissing[0];
  return nonMissing.every((quality) => quality === first) ? first : 'mixed';
}

function mergeTimestamps(timestamps: Array<string | null>): string | null {
  const nonEmpty = timestamps.filter((timestamp): timestamp is string => Boolean(timestamp));
  if (nonEmpty.length === 0) {
    return null;
  }
  const first = nonEmpty[0];
  return nonEmpty.every((timestamp) => timestamp === first) ? first : null;
}

function addTokenAggregate(
  tokenAggregates: Map<string, TokenAggregate>,
  mint: string,
  metrics: {
    liquidity: ConversionResult;
    debt: ConversionResult;
    borrowRate: MetricBaseline;
    utilization: MetricBaseline;
  }
): void {
  const aggregate = tokenAggregates.get(mint) ?? {
    liquidityUsd: 0,
    liquidityMissing: false,
    debtUsd: 0,
    debtMissing: false,
    borrowRates: [],
    borrowRateMissing: false,
    utilizations: [],
    utilizationMissing: false,
  };

  if (metrics.liquidity.quality === 'missing' || metrics.liquidity.usd === null) {
    aggregate.liquidityMissing = true;
  } else {
    aggregate.liquidityUsd += metrics.liquidity.usd;
  }

  if (metrics.debt.quality === 'missing' || metrics.debt.usd === null) {
    aggregate.debtMissing = true;
  } else {
    aggregate.debtUsd += metrics.debt.usd;
  }

  if (metrics.borrowRate.quality === 'missing' || metrics.borrowRate.value === null) {
    aggregate.borrowRateMissing = true;
  } else {
    aggregate.borrowRates.push(metrics.borrowRate.value);
  }

  if (metrics.utilization.quality === 'missing' || metrics.utilization.value === null) {
    aggregate.utilizationMissing = true;
  } else {
    aggregate.utilizations.push(metrics.utilization.value);
  }

  tokenAggregates.set(mint, aggregate);
}

function buildTokenBaselines(
  mints: string[],
  prices: Map<string, StoredPrice>,
  tokenAggregates: Map<string, TokenAggregate>
): Record<string, TokenValueBaselines> {
  const baselines: Record<string, TokenValueBaselines> = {};

  for (const mint of mints) {
    const price = prices.get(mint);
    const aggregate = tokenAggregates.get(mint);
    const priceMetric: MetricBaseline = !price || price.quality === 'missing' || price.priceUsd <= 0
      ? missingMetric('token_price_snapshots', null)
      : {
          value: price.priceUsd,
          quality: price.quality === 'estimated' || price.quality === 'current' ? 'estimated' : 'exact',
          source: 'token_price_snapshots',
          timestamp: price.bucket.toISOString(),
          priceQuality: price.quality,
          priceTimestamp: price.bucket.toISOString(),
        };

    baselines[mint] = {
      mint,
      metrics: {
        priceUsd: priceMetric,
        liquidityUsd: aggregate && !aggregate.liquidityMissing
          ? estimatedNumberMetric(aggregate.liquidityUsd, priceMetric.timestamp ?? null, 'historical_token_liquidity')
          : missingMetric('historical_token_liquidity', priceMetric.timestamp ?? null),
        debtUsd: aggregate && !aggregate.debtMissing
          ? estimatedNumberMetric(aggregate.debtUsd, priceMetric.timestamp ?? null, 'historical_token_debt')
          : missingMetric('historical_token_debt', priceMetric.timestamp ?? null),
        borrowRate: aggregate && !aggregate.borrowRateMissing && aggregate.borrowRates.length > 0
          ? estimatedNumberMetric(Math.min(...aggregate.borrowRates), priceMetric.timestamp ?? null, 'historical_token_borrow_rate')
          : missingMetric('historical_token_borrow_rate', priceMetric.timestamp ?? null),
        utilization: aggregate && !aggregate.utilizationMissing && aggregate.utilizations.length > 0
          ? estimatedNumberMetric(average(aggregate.utilizations), priceMetric.timestamp ?? null, 'historical_token_utilization')
          : missingMetric('historical_token_utilization', priceMetric.timestamp ?? null),
      },
    };
  }

  return baselines;
}

function average(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}
