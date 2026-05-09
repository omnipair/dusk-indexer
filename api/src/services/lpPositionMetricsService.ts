import { QueryResult, QueryResultRow } from 'pg';
import { getCurrentTokenPrices } from './tokenPriceSnapshotService';
import { calculateValueDeltaUsd, parseNumber, tokenRawToUsd } from '../utils/portfolioMath';

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
}

export interface LpPositionMetrics {
  earnings: {
    accruedInterest: {
      token0Amount: string;
      token1Amount: string;
      usd: string;
    };
    swapFees: {
      token0Amount: string;
      token1Amount: string;
      usd: string;
    };
    totalEarned: {
      token0Amount: string;
      token1Amount: string;
      usd: string;
    };
  };
  valueDelta: {
    netContributed: {
      token0Amount: string;
      token1Amount: string;
      usd: string;
    };
    currentValue: {
      token0Amount: string;
      token1Amount: string;
      usd: string;
    };
    delta: {
      token0Amount: string;
      token1Amount: string;
      usd: string;
    };
  };
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
      SELECT pair, signer, accrued_interest0, accrued_interest1, swap_fees0, swap_fees1,
        accrued_interest_usd, swap_fees_usd, total_earned_usd
      FROM lp_position_earnings
      WHERE signer = ANY($1::text[])
        AND pair = ANY($2::text[])
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
  positions: LiquidityPositionMetricInput[]
): Promise<Map<string, LpPositionMetrics>> {
  const [earningsByPosition, contributionsByPosition, currentPrices] = await Promise.all([
    loadEarnings(db, positions),
    loadNetContributions(db, positions),
    getCurrentTokenPrices(positions.flatMap((position) => [position.token0Mint, position.token1Mint])),
  ]);

  const metrics = new Map<string, LpPositionMetrics>();
  for (const position of positions) {
    const key = metricKey(position.signer, position.pair);
    const earnings = earningsByPosition.get(key);
    const contribution = contributionsByPosition.get(key);
    const token0Price = currentPrices.get(position.token0Mint);
    const token1Price = currentPrices.get(position.token1Mint);

    const netToken0 = parseNumber(contribution?.net_amount0);
    const netToken1 = parseNumber(contribution?.net_amount1);
    const currentToken0 = parseNumber(position.amount0);
    const currentToken1 = parseNumber(position.amount1);
    const currentValueUsd =
      tokenRawToUsd(currentToken0, token0Price) + tokenRawToUsd(currentToken1, token1Price);
    const netContributedUsd =
      tokenRawToUsd(netToken0, token0Price) + tokenRawToUsd(netToken1, token1Price);
    const deltaUsd = calculateValueDeltaUsd(currentValueUsd, netContributedUsd);

    const accruedInterest0 = parseNumber(earnings?.accrued_interest0);
    const accruedInterest1 = parseNumber(earnings?.accrued_interest1);
    const swapFees0 = parseNumber(earnings?.swap_fees0);
    const swapFees1 = parseNumber(earnings?.swap_fees1);
    const accruedInterestUsd = parseNumber(earnings?.accrued_interest_usd);
    const swapFeesUsd = parseNumber(earnings?.swap_fees_usd);

    metrics.set(key, {
      earnings: {
        accruedInterest: {
          token0Amount: numericString(accruedInterest0),
          token1Amount: numericString(accruedInterest1),
          usd: numericString(accruedInterestUsd),
        },
        swapFees: {
          token0Amount: numericString(swapFees0),
          token1Amount: numericString(swapFees1),
          usd: numericString(swapFeesUsd),
        },
        totalEarned: {
          token0Amount: numericString(accruedInterest0 + swapFees0),
          token1Amount: numericString(accruedInterest1 + swapFees1),
          usd: numericString(earnings?.total_earned_usd ?? accruedInterestUsd + swapFeesUsd),
        },
      },
      valueDelta: {
        netContributed: {
          token0Amount: numericString(netToken0),
          token1Amount: numericString(netToken1),
          usd: numericString(netContributedUsd),
        },
        currentValue: {
          token0Amount: numericString(currentToken0),
          token1Amount: numericString(currentToken1),
          usd: numericString(currentValueUsd),
        },
        delta: {
          token0Amount: numericString(currentToken0 - netToken0),
          token1Amount: numericString(currentToken1 - netToken1),
          usd: numericString(deltaUsd),
        },
      },
    });
  }

  return metrics;
}

export function getLpPositionMetricKey(signer: string, pair: string): string {
  return metricKey(signer, pair);
}
