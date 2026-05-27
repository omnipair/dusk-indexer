import { QueryResult, QueryResultRow } from 'pg';
import {
  HistoricalPriceRangeOptions,
  HistoricalPriceRangeBackfillResult,
  HistoricalTokenPriceCache,
  backfillHistoricalTokenPricesRange,
  createHistoricalTokenPriceCache,
} from './tokenPriceSnapshotService';
import { backfillPortfolioSnapshots } from './portfolioSnapshotService';
import { HOUR_MS, floorToHour } from '../utils/portfolioMath';

interface Queryable {
  query<T extends QueryResultRow = any>(text: string, params?: any[]): Promise<QueryResult<T>>;
}

interface MintRow {
  mint: string;
}

interface RepriceDryRunRow {
  candidate_events: number;
  affected_positions: number;
  affected_users: number;
}

interface RepricedEventRow {
  pair: string;
  signer: string;
}

interface AggregateRefreshRow {
  refreshed_positions: number;
}

export interface LpValuationRepairOptions {
  dryRun?: boolean;
  from?: Date;
  to?: Date;
  pair?: string;
  lookbackHours?: number;
  priceCache?: HistoricalTokenPriceCache;
  priceBackfillOptions?: Partial<HistoricalPriceRangeOptions>;
  rebuildSnapshots?: boolean;
}

export interface LpValuationRepairResult {
  dryRun: boolean;
  from: string;
  to: string;
  mints: number;
  priceBackfill: HistoricalPriceRangeBackfillResult;
  repricedEvents: number;
  affectedPositions: number;
  affectedUsers: number;
  refreshedAggregates: number;
  rebuiltSnapshots: number;
}

function emptyPriceBackfill(dryRun: boolean): HistoricalPriceRangeBackfillResult {
  return {
    buckets: 0,
    requestedMints: 0,
    fetchedMints: 0,
    failedMints: 0,
    skippedExisting: 0,
    written: 0,
    historicalWritten: 0,
    estimatedWritten: 0,
    missingWritten: 0,
    dryRun,
  };
}

async function defaultRepairFrom(db: Queryable, pair?: string): Promise<Date> {
  const params: any[] = [];
  const filters = ["price_quality IN ('missing', 'estimated')"];
  if (pair) {
    params.push(pair);
    filters.push(`pair = $${params.length}`);
  }

  const result = await db.query<{ from_bucket: Date | string | null }>(
    `
      SELECT MIN(date_trunc('hour', event_timestamp)) AS from_bucket
      FROM lp_position_earning_events
      WHERE ${filters.join(' AND ')}
    `,
    params
  );

  const from = result.rows[0]?.from_bucket;
  return from ? floorToHour(new Date(from)) : floorToHour(new Date());
}

async function loadAffectedMints(
  db: Queryable,
  from: Date,
  to: Date,
  pair?: string
): Promise<string[]> {
  const params: any[] = [from, to];
  const filters = [
    "events.price_quality IN ('missing', 'estimated')",
    'events.event_timestamp >= $1',
    'events.event_timestamp <= $2',
  ];
  if (pair) {
    params.push(pair);
    filters.push(`events.pair = $${params.length}`);
  }

  const result = await db.query<MintRow>(
    `
      SELECT DISTINCT mint
      FROM (
        SELECT pools.token0 AS mint
        FROM lp_position_earning_events events
        JOIN pools ON pools.pair_address = events.pair
        WHERE ${filters.join(' AND ')}
          AND ABS(events.token0_amount) > 0
        UNION
        SELECT pools.token1 AS mint
        FROM lp_position_earning_events events
        JOIN pools ON pools.pair_address = events.pair
        WHERE ${filters.join(' AND ')}
          AND ABS(events.token1_amount) > 0
      ) affected_mints
      WHERE mint IS NOT NULL
      ORDER BY mint
    `,
    params
  );

  return result.rows.map((row) => row.mint);
}

function repriceFilters(pair?: string): { clause: string; params: any[] } {
  const params: any[] = [];
  const filters = [
    "events.price_quality IN ('missing', 'estimated')",
    'events.event_timestamp >= $1',
    'events.event_timestamp <= $2',
  ];
  if (pair) {
    params.push(pair);
    filters.push(`events.pair = $${params.length + 2}`);
  }
  return { clause: filters.join(' AND '), params };
}

async function dryRunRepriceEvents(
  db: Queryable,
  from: Date,
  to: Date,
  pair?: string
): Promise<RepriceDryRunRow> {
  const { clause, params } = repriceFilters(pair);
  const result = await db.query<RepriceDryRunRow>(
    `
      SELECT
        COUNT(*)::integer AS candidate_events,
        COUNT(DISTINCT events.pair || ':' || events.signer)::integer AS affected_positions,
        COUNT(DISTINCT events.signer)::integer AS affected_users
      FROM lp_position_earning_events events
      WHERE ${clause}
    `,
    [from, to, ...params]
  );

  return result.rows[0] ?? {
    candidate_events: 0,
    affected_positions: 0,
    affected_users: 0,
  };
}

async function refreshAggregatesForPositions(
  db: Queryable,
  positions: Array<{ pair: string; signer: string }>
): Promise<number> {
  if (positions.length === 0) {
    return 0;
  }

  const result = await db.query<AggregateRefreshRow>(
    `
      WITH affected(pair, signer) AS (
        SELECT pair, signer
        FROM jsonb_to_recordset($1::jsonb) AS rows(pair text, signer text)
      ),
      refreshed AS (
        INSERT INTO lp_position_earnings (
          pair, signer,
          accrued_interest0, accrued_interest1,
          swap_fees0, swap_fees1,
          accrued_interest_usd, swap_fees_usd,
          total_earned_usd, updated_at
        )
        SELECT
          earning_events.pair,
          earning_events.signer,
          COALESCE(SUM(CASE WHEN earning_events.source = 'borrow_interest' THEN earning_events.token0_amount ELSE 0 END), 0),
          COALESCE(SUM(CASE WHEN earning_events.source = 'borrow_interest' THEN earning_events.token1_amount ELSE 0 END), 0),
          COALESCE(SUM(CASE WHEN earning_events.source = 'swap_fee' THEN earning_events.token0_amount ELSE 0 END), 0),
          COALESCE(SUM(CASE WHEN earning_events.source = 'swap_fee' THEN earning_events.token1_amount ELSE 0 END), 0),
          COALESCE(SUM(CASE WHEN earning_events.source = 'borrow_interest' THEN earning_events.total_usd ELSE 0 END), 0),
          COALESCE(SUM(CASE WHEN earning_events.source = 'swap_fee' THEN earning_events.total_usd ELSE 0 END), 0),
          COALESCE(SUM(earning_events.total_usd), 0),
          now()
        FROM lp_position_earning_events earning_events
        JOIN affected
          ON affected.pair = earning_events.pair
         AND affected.signer = earning_events.signer
        GROUP BY earning_events.pair, earning_events.signer
        ON CONFLICT (pair, signer) DO UPDATE SET
          accrued_interest0 = EXCLUDED.accrued_interest0,
          accrued_interest1 = EXCLUDED.accrued_interest1,
          swap_fees0 = EXCLUDED.swap_fees0,
          swap_fees1 = EXCLUDED.swap_fees1,
          accrued_interest_usd = EXCLUDED.accrued_interest_usd,
          swap_fees_usd = EXCLUDED.swap_fees_usd,
          total_earned_usd = EXCLUDED.total_earned_usd,
          updated_at = now()
        RETURNING pair, signer
      )
      SELECT COUNT(*)::integer AS refreshed_positions
      FROM refreshed
    `,
    [JSON.stringify(positions)]
  );

  return result.rows[0]?.refreshed_positions ?? 0;
}

async function repriceEvents(
  db: Queryable,
  from: Date,
  to: Date,
  pair?: string
): Promise<RepricedEventRow[]> {
  const { clause, params } = repriceFilters(pair);
  const result = await db.query<RepricedEventRow>(
    `
      WITH candidates AS (
        SELECT
          events.id,
          events.pair,
          events.signer,
          events.token0_amount,
          events.token1_amount,
          pools.token0,
          pools.token1,
          COALESCE(price0.price_usd, 0) AS token0_price_usd,
          COALESCE(price1.price_usd, 0) AS token1_price_usd,
          COALESCE(price0.decimals, 6) AS token0_decimals,
          COALESCE(price1.decimals, 6) AS token1_decimals,
          price0.quality AS token0_price_quality,
          price1.quality AS token1_price_quality
        FROM lp_position_earning_events events
        JOIN pools ON pools.pair_address = events.pair
        LEFT JOIN token_price_snapshots price0
          ON price0.mint = pools.token0
         AND price0.bucket = date_trunc('hour', events.event_timestamp)
         AND price0.provider = 'birdeye'
        LEFT JOIN token_price_snapshots price1
          ON price1.mint = pools.token1
         AND price1.bucket = date_trunc('hour', events.event_timestamp)
         AND price1.provider = 'birdeye'
        WHERE ${clause}
      ),
      repriced AS (
        SELECT
          *,
          token0_amount / power(10::numeric, token0_decimals) * token0_price_usd AS next_token0_usd,
          token1_amount / power(10::numeric, token1_decimals) * token1_price_usd AS next_token1_usd,
          CASE
            WHEN ABS(token0_amount) > 0
              AND (token0_price_quality = 'missing' OR token0_price_quality IS NULL)
              THEN 'missing'
            WHEN ABS(token1_amount) > 0
              AND (token1_price_quality = 'missing' OR token1_price_quality IS NULL)
              THEN 'missing'
            WHEN ABS(token0_amount) > 0
              AND token0_price_quality = 'estimated'
              THEN 'estimated'
            WHEN ABS(token1_amount) > 0
              AND token1_price_quality = 'estimated'
              THEN 'estimated'
            WHEN ABS(token0_amount) > 0
              AND token0_price_quality = 'current'
              THEN 'current'
            WHEN ABS(token1_amount) > 0
              AND token1_price_quality = 'current'
              THEN 'current'
            ELSE 'historical'
          END AS next_price_quality
        FROM candidates
      ),
      updated AS (
        UPDATE lp_position_earning_events events
        SET
          token0_usd = repriced.next_token0_usd,
          token1_usd = repriced.next_token1_usd,
          total_usd = repriced.next_token0_usd + repriced.next_token1_usd,
          price_quality = repriced.next_price_quality,
          updated_at = now()
        FROM repriced
        WHERE events.id = repriced.id
        RETURNING events.pair, events.signer
      )
      SELECT pair, signer
      FROM updated
    `,
    [from, to, ...params]
  );

  return result.rows;
}

function uniquePositions(rows: RepricedEventRow[]): RepricedEventRow[] {
  return Array.from(
    new Map(rows.map((row) => [`${row.pair}:${row.signer}`, row])).values()
  );
}

export async function repairLpEarningsValuations(
  db: Queryable,
  options: LpValuationRepairOptions = {}
): Promise<LpValuationRepairResult> {
  const dryRun = Boolean(options.dryRun);
  const to = floorToHour(options.to ?? new Date());
  const from = floorToHour(
    options.from
      ?? (options.lookbackHours
        ? new Date(to.getTime() - options.lookbackHours * HOUR_MS)
        : await defaultRepairFrom(db, options.pair))
  );
  const priceCache = options.priceCache ?? createHistoricalTokenPriceCache();
  const mints = await loadAffectedMints(db, from, to, options.pair);
  const priceBackfill = mints.length === 0
    ? emptyPriceBackfill(dryRun)
    : await backfillHistoricalTokenPricesRange(db, mints, from, to, {
      ...options.priceBackfillOptions,
      dryRun,
      allowCurrentFallback: true,
      refreshEstimated: true,
      refreshMissing: true,
      cache: priceCache,
    });

  const dryRunCounts = dryRun
    ? await dryRunRepriceEvents(db, from, to, options.pair)
    : null;
  const repricedRows = dryRun
    ? []
    : await repriceEvents(db, from, to, options.pair);
  const repricedPositions = uniquePositions(repricedRows);
  const affectedUsers = dryRun
    ? dryRunCounts?.affected_users ?? 0
    : new Set(repricedPositions.map((position) => position.signer)).size;
  const refreshedAggregates = dryRun
    ? 0
    : await refreshAggregatesForPositions(db, repricedPositions);

  let rebuiltSnapshots = 0;
  if (!dryRun && options.rebuildSnapshots !== false) {
    for (const signer of new Set(repricedPositions.map((position) => position.signer))) {
      const result = await backfillPortfolioSnapshots(db, {
        userAddress: signer,
        from,
        to,
        skipExisting: false,
        priceCache,
      });
      rebuiltSnapshots += result.written;
    }
  }

  return {
    dryRun,
    from: from.toISOString(),
    to: to.toISOString(),
    mints: mints.length,
    priceBackfill,
    repricedEvents: dryRun ? dryRunCounts?.candidate_events ?? 0 : repricedRows.length,
    affectedPositions: dryRun ? dryRunCounts?.affected_positions ?? 0 : repricedPositions.length,
    affectedUsers,
    refreshedAggregates,
    rebuiltSnapshots,
  };
}
