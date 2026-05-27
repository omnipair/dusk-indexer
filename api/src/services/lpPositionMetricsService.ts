import { QueryResult, QueryResultRow } from 'pg';
import { getCurrentTokenPrices } from './tokenPriceSnapshotService';
import {
  CurrentLpTokenAmounts,
  currentLpValuationKey,
  loadCurrentLpTokenAmounts,
} from './currentLpValuationService';
import {
  PriceQuality,
  TokenPrice,
  amountAwarePriceQuality,
  parseNumber,
  tokenRawToUsd,
} from '../utils/portfolioMath';

interface Queryable {
  query<T extends QueryResultRow = any>(text: string, params?: any[]): Promise<QueryResult<T>>;
}

export interface LiquidityPositionMetricInput {
  signer: string;
  pair: string;
  token0Mint: string;
  token1Mint: string;
  amount0: string;
  amount1: string;
  lpAmount: string;
}

export type LpUsdPriceBasis = 'historical' | 'current';

export interface LpAmountBreakdown {
  token0Amount: string;
  token1Amount: string;
  token0HistoricalUsd: string;
  token1HistoricalUsd: string;
  token0CurrentUsd: string;
  token1CurrentUsd: string;
  usd: string;
  historicalUsd: string;
  currentUsd: string;
  priceQuality: PriceQuality;
  currentPriceQuality: PriceQuality;
  priceBasis: LpUsdPriceBasis;
}

export interface LpPositionMetrics {
  earnings: {
    accruedInterest: LpAmountBreakdown;
    swapFees: LpAmountBreakdown;
    totalEarned: LpAmountBreakdown;
  };
  valueDelta: {
    netContributed: LpAmountBreakdown;
    currentValue: LpAmountBreakdown;
    delta: LpAmountBreakdown;
  };
}

export interface LpPositionMetricsOptions {
  currentPrices?: Map<string, TokenPrice>;
  currentAmountsByPosition?: Map<string, CurrentLpTokenAmounts>;
}

interface EarningsRow {
  pair: string;
  signer: string;
  accrued_interest0: string | null;
  accrued_interest1: string | null;
  swap_fees0: string | null;
  swap_fees1: string | null;
  accrued_interest_usd: string | null;
  swap_fees_usd: string | null;
  total_earned_usd: string | null;
  accrued_interest_token0_usd: string | null;
  accrued_interest_token1_usd: string | null;
  swap_fees_token0_usd: string | null;
  swap_fees_token1_usd: string | null;
  total_earned_token0_usd: string | null;
  total_earned_token1_usd: string | null;
  accrued_interest_price_quality: PriceQuality | null;
  swap_fees_price_quality: PriceQuality | null;
  total_earned_price_quality: PriceQuality | null;
}

interface ContributionRow {
  pair: string;
  signer: string;
  net_amount0: string | null;
  net_amount1: string | null;
}

function metricKey(signer: string, pair: string): string {
  return `${signer}:${pair}`;
}

function numericString(value: unknown): string {
  return String(parseNumber(value));
}

function normalizePriceQuality(value: unknown): PriceQuality {
  return value === 'missing' || value === 'estimated' || value === 'current' || value === 'historical'
    ? value
    : 'historical';
}

function currentTokenUsdBySide(
  token0Amount: number,
  token1Amount: number,
  token0Price: TokenPrice | null | undefined,
  token1Price: TokenPrice | null | undefined
): { token0CurrentUsd: number; token1CurrentUsd: number } {
  return {
    token0CurrentUsd: tokenRawToUsd(token0Amount, token0Price),
    token1CurrentUsd: tokenRawToUsd(token1Amount, token1Price),
  };
}

function buildHistoricalBreakdown({
  token0Amount,
  token1Amount,
  historicalUsd,
  token0HistoricalUsd,
  token1HistoricalUsd,
  historicalPriceQuality,
  token0Price,
  token1Price,
}: {
  token0Amount: number;
  token1Amount: number;
  historicalUsd: number;
  token0HistoricalUsd: number;
  token1HistoricalUsd: number;
  historicalPriceQuality: PriceQuality;
  token0Price: TokenPrice | null | undefined;
  token1Price: TokenPrice | null | undefined;
}): LpAmountBreakdown {
  const { token0CurrentUsd, token1CurrentUsd } = currentTokenUsdBySide(
    token0Amount,
    token1Amount,
    token0Price,
    token1Price
  );
  const currentUsd = token0CurrentUsd + token1CurrentUsd;
  return {
    token0Amount: numericString(token0Amount),
    token1Amount: numericString(token1Amount),
    token0HistoricalUsd: numericString(token0HistoricalUsd),
    token1HistoricalUsd: numericString(token1HistoricalUsd),
    token0CurrentUsd: numericString(token0CurrentUsd),
    token1CurrentUsd: numericString(token1CurrentUsd),
    usd: numericString(historicalUsd),
    historicalUsd: numericString(historicalUsd),
    currentUsd: numericString(currentUsd),
    priceQuality: historicalPriceQuality,
    currentPriceQuality: amountAwarePriceQuality(token0Amount, token1Amount, token0Price, token1Price),
    priceBasis: 'historical',
  };
}

function buildCurrentBreakdown({
  token0Amount,
  token1Amount,
  token0Price,
  token1Price,
}: {
  token0Amount: number;
  token1Amount: number;
  token0Price: TokenPrice | null | undefined;
  token1Price: TokenPrice | null | undefined;
}): LpAmountBreakdown {
  const { token0CurrentUsd, token1CurrentUsd } = currentTokenUsdBySide(
    token0Amount,
    token1Amount,
    token0Price,
    token1Price
  );
  const currentUsd = token0CurrentUsd + token1CurrentUsd;
  const currentPriceQuality = amountAwarePriceQuality(token0Amount, token1Amount, token0Price, token1Price);
  return {
    token0Amount: numericString(token0Amount),
    token1Amount: numericString(token1Amount),
    token0HistoricalUsd: numericString(token0CurrentUsd),
    token1HistoricalUsd: numericString(token1CurrentUsd),
    token0CurrentUsd: numericString(token0CurrentUsd),
    token1CurrentUsd: numericString(token1CurrentUsd),
    usd: numericString(currentUsd),
    historicalUsd: numericString(currentUsd),
    currentUsd: numericString(currentUsd),
    priceQuality: currentPriceQuality,
    currentPriceQuality,
    priceBasis: 'current',
  };
}

async function loadEarnings(
  db: Queryable,
  positions: LiquidityPositionMetricInput[]
): Promise<Map<string, EarningsRow>> {
  if (positions.length === 0) {
    return new Map();
  }

  const signers = [...new Set(positions.map((position) => position.signer))];
  const pairs = [...new Set(positions.map((position) => position.pair))];
  const result = await db.query<EarningsRow>(
    `
      WITH quality_by_position AS (
        SELECT
          pair,
          signer,
          CASE
            WHEN BOOL_OR(source = 'borrow_interest' AND price_quality = 'missing') THEN 'missing'
            WHEN BOOL_OR(source = 'borrow_interest' AND price_quality = 'estimated') THEN 'estimated'
            WHEN BOOL_OR(source = 'borrow_interest' AND price_quality = 'current') THEN 'current'
            WHEN BOOL_OR(source = 'borrow_interest') THEN 'historical'
            ELSE 'historical'
          END AS accrued_interest_price_quality,
          CASE
            WHEN BOOL_OR(source = 'swap_fee' AND price_quality = 'missing') THEN 'missing'
            WHEN BOOL_OR(source = 'swap_fee' AND price_quality = 'estimated') THEN 'estimated'
            WHEN BOOL_OR(source = 'swap_fee' AND price_quality = 'current') THEN 'current'
            WHEN BOOL_OR(source = 'swap_fee') THEN 'historical'
            ELSE 'historical'
          END AS swap_fees_price_quality,
          CASE
            WHEN BOOL_OR(price_quality = 'missing') THEN 'missing'
            WHEN BOOL_OR(price_quality = 'estimated') THEN 'estimated'
            WHEN BOOL_OR(price_quality = 'current') THEN 'current'
            WHEN COUNT(*) > 0 THEN 'historical'
            ELSE 'historical'
          END AS total_earned_price_quality
        FROM lp_position_earning_events
        WHERE signer = ANY($1::text[])
          AND pair = ANY($2::text[])
        GROUP BY pair, signer
      ),
      event_usd_by_position AS (
        SELECT
          pair,
          signer,
          COALESCE(SUM(CASE WHEN source = 'borrow_interest' THEN token0_usd ELSE 0 END), 0) AS accrued_interest_token0_usd,
          COALESCE(SUM(CASE WHEN source = 'borrow_interest' THEN token1_usd ELSE 0 END), 0) AS accrued_interest_token1_usd,
          COALESCE(SUM(CASE WHEN source = 'swap_fee' THEN token0_usd ELSE 0 END), 0) AS swap_fees_token0_usd,
          COALESCE(SUM(CASE WHEN source = 'swap_fee' THEN token1_usd ELSE 0 END), 0) AS swap_fees_token1_usd,
          COALESCE(SUM(token0_usd), 0) AS total_earned_token0_usd,
          COALESCE(SUM(token1_usd), 0) AS total_earned_token1_usd
        FROM lp_position_earning_events
        WHERE signer = ANY($1::text[])
          AND pair = ANY($2::text[])
        GROUP BY pair, signer
      )
      SELECT pair, signer, accrued_interest0, accrued_interest1, swap_fees0, swap_fees1,
        accrued_interest_usd, swap_fees_usd, total_earned_usd,
        event_usd_by_position.accrued_interest_token0_usd,
        event_usd_by_position.accrued_interest_token1_usd,
        event_usd_by_position.swap_fees_token0_usd,
        event_usd_by_position.swap_fees_token1_usd,
        event_usd_by_position.total_earned_token0_usd,
        event_usd_by_position.total_earned_token1_usd,
        quality_by_position.accrued_interest_price_quality,
        quality_by_position.swap_fees_price_quality,
        quality_by_position.total_earned_price_quality
      FROM lp_position_earnings earnings
      LEFT JOIN quality_by_position USING (pair, signer)
      LEFT JOIN event_usd_by_position USING (pair, signer)
      WHERE earnings.signer = ANY($1::text[])
        AND earnings.pair = ANY($2::text[])
    `,
    [signers, pairs]
  );

  const byPosition = new Map<string, EarningsRow>();
  for (const row of result.rows) {
    byPosition.set(metricKey(row.signer, row.pair), row);
  }
  return byPosition;
}

async function loadNetContributions(
  db: Queryable,
  positions: LiquidityPositionMetricInput[]
): Promise<Map<string, ContributionRow>> {
  if (positions.length === 0) {
    return new Map();
  }

  const signers = [...new Set(positions.map((position) => position.signer))];
  const pairs = [...new Set(positions.map((position) => position.pair))];
  const result = await db.query<ContributionRow>(
    `
      SELECT
        pair,
        user_address AS signer,
        COALESCE(SUM(
          CASE
            WHEN event_type IN ('add', 'mint') THEN amount0::numeric
            WHEN event_type IN ('remove', 'burn') THEN -amount0::numeric
            ELSE 0
          END
        ), 0) AS net_amount0,
        COALESCE(SUM(
          CASE
            WHEN event_type IN ('add', 'mint') THEN amount1::numeric
            WHEN event_type IN ('remove', 'burn') THEN -amount1::numeric
            ELSE 0
          END
        ), 0) AS net_amount1
      FROM adjust_liquidity
      WHERE user_address = ANY($1::text[])
        AND pair = ANY($2::text[])
      GROUP BY pair, user_address
    `,
    [signers, pairs]
  );

  const byPosition = new Map<string, ContributionRow>();
  for (const row of result.rows) {
    byPosition.set(metricKey(row.signer, row.pair), row);
  }
  return byPosition;
}

export async function getLpPositionMetricsForRows(
  db: Queryable,
  positions: LiquidityPositionMetricInput[],
  options: LpPositionMetricsOptions = {}
): Promise<Map<string, LpPositionMetrics>> {
  const [earningsByPosition, contributionsByPosition, currentPrices] = await Promise.all([
    loadEarnings(db, positions),
    loadNetContributions(db, positions),
    options.currentPrices
      ? Promise.resolve(options.currentPrices)
      : getCurrentTokenPrices(positions.flatMap((position) => [position.token0Mint, position.token1Mint])),
  ]);
  const currentAmountsByPosition = options.currentAmountsByPosition
    ?? await loadCurrentLpTokenAmounts(
      positions.map((position) => ({
        signer: position.signer,
        pair: position.pair,
        lpAmount: position.lpAmount,
        amount0: position.amount0,
        amount1: position.amount1,
      }))
    );

  const metrics = new Map<string, LpPositionMetrics>();
  for (const position of positions) {
    const key = metricKey(position.signer, position.pair);
    const earnings = earningsByPosition.get(key);
    const contribution = contributionsByPosition.get(key);
    const token0Price = currentPrices.get(position.token0Mint);
    const token1Price = currentPrices.get(position.token1Mint);

    const netToken0 = parseNumber(contribution?.net_amount0);
    const netToken1 = parseNumber(contribution?.net_amount1);
    const currentAmounts = currentAmountsByPosition.get(currentLpValuationKey(position.signer, position.pair));
    const currentToken0 = currentAmounts?.token0Amount ?? parseNumber(position.amount0);
    const currentToken1 = currentAmounts?.token1Amount ?? parseNumber(position.amount1);

    const accruedInterest0 = parseNumber(earnings?.accrued_interest0);
    const accruedInterest1 = parseNumber(earnings?.accrued_interest1);
    const swapFees0 = parseNumber(earnings?.swap_fees0);
    const swapFees1 = parseNumber(earnings?.swap_fees1);
    const accruedInterestUsd = parseNumber(earnings?.accrued_interest_usd);
    const swapFeesUsd = parseNumber(earnings?.swap_fees_usd);
    const totalEarnedUsd = parseNumber(earnings?.total_earned_usd, accruedInterestUsd + swapFeesUsd);
    const accruedInterestToken0Usd = parseNumber(earnings?.accrued_interest_token0_usd);
    const accruedInterestToken1Usd = parseNumber(earnings?.accrued_interest_token1_usd);
    const swapFeesToken0Usd = parseNumber(earnings?.swap_fees_token0_usd);
    const swapFeesToken1Usd = parseNumber(earnings?.swap_fees_token1_usd);
    const totalEarnedToken0Usd = parseNumber(
      earnings?.total_earned_token0_usd,
      accruedInterestToken0Usd + swapFeesToken0Usd
    );
    const totalEarnedToken1Usd = parseNumber(
      earnings?.total_earned_token1_usd,
      accruedInterestToken1Usd + swapFeesToken1Usd
    );

    metrics.set(key, {
      earnings: {
        accruedInterest: buildHistoricalBreakdown({
          token0Amount: accruedInterest0,
          token1Amount: accruedInterest1,
          historicalUsd: accruedInterestUsd,
          token0HistoricalUsd: accruedInterestToken0Usd,
          token1HistoricalUsd: accruedInterestToken1Usd,
          historicalPriceQuality: normalizePriceQuality(earnings?.accrued_interest_price_quality),
          token0Price,
          token1Price,
        }),
        swapFees: buildHistoricalBreakdown({
          token0Amount: swapFees0,
          token1Amount: swapFees1,
          historicalUsd: swapFeesUsd,
          token0HistoricalUsd: swapFeesToken0Usd,
          token1HistoricalUsd: swapFeesToken1Usd,
          historicalPriceQuality: normalizePriceQuality(earnings?.swap_fees_price_quality),
          token0Price,
          token1Price,
        }),
        totalEarned: buildHistoricalBreakdown({
          token0Amount: accruedInterest0 + swapFees0,
          token1Amount: accruedInterest1 + swapFees1,
          historicalUsd: totalEarnedUsd,
          token0HistoricalUsd: totalEarnedToken0Usd,
          token1HistoricalUsd: totalEarnedToken1Usd,
          historicalPriceQuality: normalizePriceQuality(earnings?.total_earned_price_quality),
          token0Price,
          token1Price,
        }),
      },
      valueDelta: {
        netContributed: buildCurrentBreakdown({
          token0Amount: netToken0,
          token1Amount: netToken1,
          token0Price,
          token1Price,
        }),
        currentValue: buildCurrentBreakdown({
          token0Amount: currentToken0,
          token1Amount: currentToken1,
          token0Price,
          token1Price,
        }),
        delta: buildCurrentBreakdown({
          token0Amount: currentToken0 - netToken0,
          token1Amount: currentToken1 - netToken1,
          token0Price,
          token1Price,
        }),
      },
    });
  }

  return metrics;
}

export function getLpPositionMetricKey(signer: string, pair: string): string {
  return metricKey(signer, pair);
}
