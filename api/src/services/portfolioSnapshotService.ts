import { PublicKey } from '@solana/web3.js';
import { QueryResult, QueryResultRow } from 'pg';
import {
  HistoricalTokenPriceCache,
  createHistoricalTokenPriceCache,
  getCurrentTokenPrices,
  getHistoricalTokenPrices,
} from './tokenPriceSnapshotService';
import { simulateUserPositionGetter } from '../utils/pairSimulation';
import {
  currentLpValuationKey,
  loadCurrentLpTokenAmounts,
} from './currentLpValuationService';
import {
  PriceQuality,
  SnapshotQuality,
  TokenPrice,
  floorToHour,
  parseNumber,
  sumTokenValueUsd,
} from '../utils/portfolioMath';

interface Queryable {
  query<T extends QueryResultRow = any>(text: string, params?: any[]): Promise<QueryResult<T>>;
}

export type PortfolioSnapshotRange = '7D' | '30D' | '90D' | 'ALL';

export interface PortfolioSnapshotPoint {
  timestamp: string;
  netValueUsd: string;
  lpDepositsUsd: string;
  collateralUsd: string;
  debtUsd: string;
  quality: SnapshotQuality;
}

export interface PortfolioSnapshotResponse {
  userAddress: string;
  range: PortfolioSnapshotRange;
  points: PortfolioSnapshotPoint[];
}

export interface PortfolioSnapshotBackfillOptions {
  dryRun?: boolean;
  userAddress?: string;
  from?: Date;
  to?: Date;
  limitUsers?: number;
  maxBucketsPerUser?: number;
  skipExisting?: boolean;
  priceCache?: HistoricalTokenPriceCache;
  progressEveryBuckets?: number;
  concurrency?: number;
  startAtFirstActivity?: boolean;
}

export interface PortfolioSnapshotBackfillResult {
  users: number;
  buckets: number;
  written: number;
  dryRun: boolean;
}

interface SnapshotRow {
  bucket: Date | string;
  net_value_usd: string;
  lp_value_usd: string;
  collateral_value_usd: string;
  debt_value_usd: string;
  quality: SnapshotQuality;
}

interface LpPositionAtBucket {
  pair: string;
  signer: string;
  lp_amount: string;
  amount0: string;
  amount1: string;
  position_timestamp: Date | string;
  token0: string;
  token1: string;
}

interface LpEarningDeltaRow {
  token0_amount: string | null;
  token1_amount: string | null;
}

interface BorrowPositionAtBucket {
  pair: string;
  position: string;
  collateral0: string;
  collateral1: string;
  debt0_shares: string;
  debt1_shares: string;
  token0: string;
  token1: string;
}

interface HistoricalDebtPrincipalRow {
  pair: string;
  debt0: string;
  debt1: string;
}

interface ActiveUserRow {
  signer: string;
}

interface SnapshotValues {
  netValueUsd: number;
  lpValueUsd: number;
  collateralValueUsd: number;
  debtValueUsd: number;
  quality: SnapshotQuality;
}

function numericString(value: unknown): string {
  return String(parseNumber(value));
}

function rangeStart(range: PortfolioSnapshotRange): Date | null {
  const now = Date.now();
  if (range === '7D') {
    return new Date(now - 7 * 24 * 60 * 60 * 1000);
  }
  if (range === '30D') {
    return new Date(now - 30 * 24 * 60 * 60 * 1000);
  }
  if (range === '90D') {
    return new Date(now - 90 * 24 * 60 * 60 * 1000);
  }
  return null;
}

function normalizeRange(value: unknown): PortfolioSnapshotRange {
  const range = String(value || '30D').toUpperCase();
  if (range === '7D' || range === '30D' || range === '90D' || range === 'ALL') {
    return range;
  }
  return '30D';
}

async function loadPrices(
  db: Queryable,
  mints: string[],
  bucket: Date,
  historical: boolean,
  dryRun: boolean,
  priceCache?: HistoricalTokenPriceCache
): Promise<Map<string, TokenPrice>> {
  if (historical) {
    return getHistoricalTokenPrices(db, mints, bucket, {
      dryRun,
      allowCurrentFallback: true,
      cache: priceCache,
    });
  }
  return getCurrentTokenPrices(mints);
}

function priceQualityIsEstimated(price: TokenPrice | undefined): boolean {
  return !price || price.quality === 'estimated' || price.quality === 'missing';
}

async function fetchHistoricalLpPositions(
  db: Queryable,
  userAddress: string,
  bucket: Date
): Promise<LpPositionAtBucket[]> {
  const result = await db.query<LpPositionAtBucket>(
    `
      SELECT DISTINCT ON (events.pair_address)
        events.pair_address AS pair,
        events.signer,
        events.lp_amount::text AS lp_amount,
        events.amount0::text AS amount0,
        events.amount1::text AS amount1,
        events."timestamp" AS position_timestamp,
        pools.token0,
        pools.token1
      FROM user_lp_position_updated_events events
      JOIN pools ON pools.pair_address = events.pair_address
      WHERE events.signer = $1
        AND events."timestamp" <= $2
      ORDER BY events.pair_address, events.slot DESC, events."timestamp" DESC, events.id DESC
    `,
    [userAddress, bucket]
  );
  return result.rows;
}

async function fetchCurrentLpPositions(
  db: Queryable,
  userAddress: string
): Promise<LpPositionAtBucket[]> {
  const result = await db.query<LpPositionAtBucket>(
    `
      SELECT
        positions.pair,
        positions.signer,
        positions.lp_amount::text AS lp_amount,
        positions.amount0::text AS amount0,
        positions.amount1::text AS amount1,
        positions.updated_at AS position_timestamp,
        pools.token0,
        pools.token1
      FROM user_liquidity_positions positions
      JOIN pools ON pools.pair_address = positions.pair
      WHERE positions.signer = $1
    `,
    [userAddress]
  );
  return result.rows;
}

async function fetchLpEarningDeltaAfterPosition(
  db: Queryable,
  userAddress: string,
  pair: string,
  from: Date,
  to: Date
): Promise<{ token0: number; token1: number }> {
  const result = await db.query<LpEarningDeltaRow>(
    `
      SELECT
        COALESCE(SUM(token0_amount), 0)::text AS token0_amount,
        COALESCE(SUM(token1_amount), 0)::text AS token1_amount
      FROM lp_position_earning_events
      WHERE signer = $1
        AND pair = $2
        AND event_timestamp > $3
        AND event_timestamp <= $4
    `,
    [userAddress, pair, from, to]
  );

  return {
    token0: parseNumber(result.rows[0]?.token0_amount),
    token1: parseNumber(result.rows[0]?.token1_amount),
  };
}

async function computeLpValueUsd(
  db: Queryable,
  userAddress: string,
  bucket: Date,
  historical: boolean,
  dryRun: boolean,
  priceCache?: HistoricalTokenPriceCache
): Promise<{ valueUsd: number; priceQuality: PriceQuality }> {
  const positions = historical
    ? await fetchHistoricalLpPositions(db, userAddress, bucket)
    : await fetchCurrentLpPositions(db, userAddress);

  const prices = await loadPrices(
    db,
    positions.flatMap((position) => [position.token0, position.token1]),
    bucket,
    historical,
    dryRun,
    priceCache
  );
  const currentAmounts = historical
    ? new Map()
    : await loadCurrentLpTokenAmounts(positions.map((position) => ({
        signer: position.signer,
        pair: position.pair,
        lpAmount: position.lp_amount,
        amount0: position.amount0,
        amount1: position.amount1,
      })));

  let valueUsd = 0;
  let priceQuality: PriceQuality = 'historical';

  for (const position of positions) {
    const liveAmounts = currentAmounts.get(currentLpValuationKey(position.signer, position.pair));
    let amount0 = liveAmounts?.token0Amount ?? parseNumber(position.amount0);
    let amount1 = liveAmounts?.token1Amount ?? parseNumber(position.amount1);

    if (historical) {
      const deltas = await fetchLpEarningDeltaAfterPosition(
        db,
        userAddress,
        position.pair,
        new Date(position.position_timestamp),
        bucket
      );
      amount0 += deltas.token0;
      amount1 += deltas.token1;
    }

    if (!historical && liveAmounts && !liveAmounts.exact) {
      priceQuality = 'estimated';
    }

    const token0Price = prices.get(position.token0);
    const token1Price = prices.get(position.token1);
    if (priceQualityIsEstimated(token0Price) || priceQualityIsEstimated(token1Price)) {
      priceQuality = 'estimated';
    }
    valueUsd += sumTokenValueUsd(amount0, amount1, token0Price, token1Price);
  }

  return { valueUsd, priceQuality };
}

async function fetchHistoricalBorrowPositions(
  db: Queryable,
  userAddress: string,
  bucket: Date
): Promise<BorrowPositionAtBucket[]> {
  const result = await db.query<BorrowPositionAtBucket>(
    `
      SELECT DISTINCT ON (events.pair, events.position)
        events.pair,
        events.position,
        events.collateral0::text AS collateral0,
        events.collateral1::text AS collateral1,
        events.debt0_shares::text AS debt0_shares,
        events.debt1_shares::text AS debt1_shares,
        pools.token0,
        pools.token1
      FROM user_position_updated_events events
      JOIN pools ON pools.pair_address = events.pair
      WHERE events.signer = $1
        AND events.event_timestamp <= $2
      ORDER BY events.pair, events.position, events.slot DESC, events.event_timestamp DESC, events.id DESC
    `,
    [userAddress, bucket]
  );
  return result.rows;
}

async function fetchCurrentBorrowPositions(
  db: Queryable,
  userAddress: string
): Promise<BorrowPositionAtBucket[]> {
  const result = await db.query<BorrowPositionAtBucket>(
    `
      SELECT
        positions.pair,
        positions.position,
        positions.collateral0::text AS collateral0,
        positions.collateral1::text AS collateral1,
        positions.debt0_shares::text AS debt0_shares,
        positions.debt1_shares::text AS debt1_shares,
        pools.token0,
        pools.token1
      FROM user_borrow_positions positions
      JOIN pools ON pools.pair_address = positions.pair
      WHERE positions.signer = $1
    `,
    [userAddress]
  );
  return result.rows;
}

async function fetchHistoricalDebtPrincipalByPair(
  db: Queryable,
  userAddress: string,
  bucket: Date,
  pairs: string[]
): Promise<Map<string, { debt0: number; debt1: number; exact: boolean }>> {
  const uniquePairs = [...new Set(pairs.filter(Boolean))];
  if (uniquePairs.length === 0) {
    return new Map();
  }

  const result = await db.query<HistoricalDebtPrincipalRow>(
    `
      SELECT
        pair,
        GREATEST(COALESCE(SUM(amount0), 0), 0)::text AS debt0,
        GREATEST(COALESCE(SUM(amount1), 0), 0)::text AS debt1
      FROM adjust_debt_events
      WHERE signer = $1
        AND pair = ANY($2::text[])
        AND event_timestamp <= $3
      GROUP BY pair
    `,
    [userAddress, uniquePairs, bucket]
  );

  const debtByPair = new Map<string, { debt0: number; debt1: number; exact: boolean }>();
  for (const row of result.rows) {
    debtByPair.set(row.pair, {
      debt0: parseNumber(row.debt0),
      debt1: parseNumber(row.debt1),
      exact: false,
    });
  }

  return debtByPair;
}

async function getCurrentDebtWithInterest(
  position: BorrowPositionAtBucket
): Promise<{ debt0: number; debt1: number; exact: boolean }> {
  try {
    const { initializePairStateService } = await import('../controllers/helpers/controllerBase');
    const pairStateService = await initializePairStateService();
    const program = pairStateService.getProgram();
    if (!program) {
      return {
        debt0: parseNumber(position.debt0_shares),
        debt1: parseNumber(position.debt1_shares),
        exact: false,
      };
    }

    const result = await simulateUserPositionGetter(
      program,
      pairStateService.getConnection(),
      new PublicKey(position.pair),
      new PublicKey(position.position),
      { userDebtWithInterest: {} }
    );

    return {
      debt0: parseNumber(result.value0),
      debt1: parseNumber(result.value1),
      exact: true,
    };
  } catch (error) {
    console.warn(`Falling back to debt shares for portfolio snapshot on ${position.position}:`, error);
    return {
      debt0: parseNumber(position.debt0_shares),
      debt1: parseNumber(position.debt1_shares),
      exact: false,
    };
  }
}

async function computeBorrowValueUsd(
  db: Queryable,
  userAddress: string,
  bucket: Date,
  historical: boolean,
  dryRun: boolean,
  priceCache?: HistoricalTokenPriceCache
): Promise<{ collateralUsd: number; debtUsd: number; quality: SnapshotQuality }> {
  const positions = historical
    ? await fetchHistoricalBorrowPositions(db, userAddress, bucket)
    : await fetchCurrentBorrowPositions(db, userAddress);
  const prices = await loadPrices(
    db,
    positions.flatMap((position) => [position.token0, position.token1]),
    bucket,
    historical,
    dryRun,
    priceCache
  );

  let collateralUsd = 0;
  let debtUsd = 0;
  let quality: SnapshotQuality = historical ? 'estimated' : 'exact';
  const historicalDebtByPair = historical
    ? await fetchHistoricalDebtPrincipalByPair(
        db,
        userAddress,
        bucket,
        positions.map((position) => position.pair)
      )
    : new Map<string, { debt0: number; debt1: number; exact: boolean }>();
  const countedHistoricalDebtPairs = new Set<string>();

  for (const position of positions) {
    const hasHistoricalDebt =
      parseNumber(position.debt0_shares) > 0 || parseNumber(position.debt1_shares) > 0;
    const token0Price = prices.get(position.token0);
    const token1Price = prices.get(position.token1);
    if (priceQualityIsEstimated(token0Price) || priceQualityIsEstimated(token1Price)) {
      quality = 'estimated';
    }

    collateralUsd += sumTokenValueUsd(
      position.collateral0,
      position.collateral1,
      token0Price,
      token1Price
    );

    const debt = historical
      ? countedHistoricalDebtPairs.has(position.pair)
        ? { debt0: 0, debt1: 0, exact: false }
        : {
            debt0: parseNumber(position.debt0_shares) > 0
              ? historicalDebtByPair.get(position.pair)?.debt0 ?? 0
              : 0,
            debt1: parseNumber(position.debt1_shares) > 0
              ? historicalDebtByPair.get(position.pair)?.debt1 ?? 0
              : 0,
            exact: false,
          }
      : await getCurrentDebtWithInterest(position);

    if (historical && hasHistoricalDebt) {
      countedHistoricalDebtPairs.add(position.pair);
    }

    if (!debt.exact) {
      quality = 'estimated';
    }
    debtUsd += sumTokenValueUsd(debt.debt0, debt.debt1, token0Price, token1Price);
  }

  return { collateralUsd, debtUsd, quality };
}

export async function computePortfolioSnapshotValues(
  db: Queryable,
  userAddress: string,
  bucket: Date,
  options: { historical?: boolean; dryRun?: boolean; priceCache?: HistoricalTokenPriceCache } = {}
): Promise<SnapshotValues> {
  const historical = Boolean(options.historical);
  const [lpValue, borrowValue] = await Promise.all([
    computeLpValueUsd(db, userAddress, bucket, historical, Boolean(options.dryRun), options.priceCache),
    computeBorrowValueUsd(db, userAddress, bucket, historical, Boolean(options.dryRun), options.priceCache),
  ]);
  const quality: SnapshotQuality =
    historical || lpValue.priceQuality === 'estimated' || borrowValue.quality === 'estimated'
      ? 'estimated'
      : 'exact';

  return {
    lpValueUsd: lpValue.valueUsd,
    collateralValueUsd: borrowValue.collateralUsd,
    debtValueUsd: borrowValue.debtUsd,
    netValueUsd: lpValue.valueUsd + borrowValue.collateralUsd - borrowValue.debtUsd,
    quality,
  };
}

export async function upsertPortfolioSnapshot(
  db: Queryable,
  userAddress: string,
  bucket: Date,
  values: SnapshotValues,
  source: 'snapshotter' | 'backfill' | 'manual'
): Promise<void> {
  await db.query(
    `
      INSERT INTO portfolio_value_snapshots (
        user_address, bucket, net_value_usd, lp_value_usd,
        collateral_value_usd, debt_value_usd, quality, source, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
      ON CONFLICT (user_address, bucket) DO UPDATE SET
        net_value_usd = EXCLUDED.net_value_usd,
        lp_value_usd = EXCLUDED.lp_value_usd,
        collateral_value_usd = EXCLUDED.collateral_value_usd,
        debt_value_usd = EXCLUDED.debt_value_usd,
        quality = EXCLUDED.quality,
        source = EXCLUDED.source,
        updated_at = now()
    `,
    [
      userAddress,
      bucket,
      values.netValueUsd,
      values.lpValueUsd,
      values.collateralValueUsd,
      values.debtValueUsd,
      values.quality,
      source,
    ]
  );
}

export async function getUserPortfolioSnapshots(
  db: Queryable,
  userAddress: string,
  requestedRange: unknown
): Promise<PortfolioSnapshotResponse> {
  const range = normalizeRange(requestedRange);
  const start = rangeStart(range);
  const params: any[] = [userAddress];
  let where = 'WHERE user_address = $1';

  if (start) {
    params.push(start);
    where += ` AND bucket >= $${params.length}`;
  }

  const result = await db.query<SnapshotRow>(
    `
      SELECT bucket, net_value_usd, lp_value_usd, collateral_value_usd, debt_value_usd, quality
      FROM portfolio_value_snapshots
      ${where}
      ORDER BY bucket ASC
    `,
    params
  );

  return {
    userAddress,
    range,
    points: result.rows.map((row) => ({
      timestamp: new Date(row.bucket).toISOString(),
      netValueUsd: numericString(row.net_value_usd),
      lpDepositsUsd: numericString(row.lp_value_usd),
      collateralUsd: numericString(row.collateral_value_usd),
      debtUsd: numericString(row.debt_value_usd),
      quality: row.quality,
    })),
  };
}

export async function fetchActivePortfolioUsers(
  db: Queryable,
  options: { userAddress?: string; limitUsers?: number } = {}
): Promise<string[]> {
  if (options.userAddress) {
    return [options.userAddress];
  }

  const params: any[] = [];
  let limitClause = '';
  if (options.limitUsers) {
    params.push(options.limitUsers);
    limitClause = `LIMIT $${params.length}`;
  }

  const result = await db.query<ActiveUserRow>(
    `
      SELECT signer
      FROM (
        SELECT signer FROM user_liquidity_positions
        UNION
        SELECT signer FROM user_lp_position_updated_events
        UNION
        SELECT signer FROM user_borrow_positions
        UNION
        SELECT signer FROM user_position_updated_events
      ) active_users
      ORDER BY signer
      ${limitClause}
    `,
    params
  );
  return result.rows.map((row) => row.signer);
}

async function defaultBackfillStart(db: Queryable): Promise<Date> {
  const result = await db.query<{ start_time: Date | string | null }>(
    `
      SELECT MIN(first_seen) AS start_time
      FROM (
        SELECT MIN("timestamp") AS first_seen FROM user_lp_position_updated_events
        UNION ALL
        SELECT MIN(event_timestamp) AS first_seen FROM user_position_updated_events
      ) starts
    `
  );

  const start = result.rows[0]?.start_time;
  return start ? floorToHour(new Date(start)) : floorToHour(new Date());
}

async function fetchExistingSnapshotBuckets(
  db: Queryable,
  userAddress: string,
  from: Date,
  to: Date
): Promise<Set<number>> {
  const result = await db.query<{ bucket: Date | string }>(
    `
      SELECT bucket
      FROM portfolio_value_snapshots
      WHERE user_address = $1
        AND bucket >= $2
        AND bucket <= $3
    `,
    [userAddress, from, to]
  );

  return new Set(result.rows.map((row) => new Date(row.bucket).getTime()));
}

async function fetchUserFirstActivityBuckets(
  db: Queryable,
  users: string[]
): Promise<Map<string, Date>> {
  if (users.length === 0) {
    return new Map();
  }

  const result = await db.query<{ signer: string; first_seen: Date | string }>(
    `
      SELECT signer, MIN(first_seen) AS first_seen
      FROM (
        SELECT signer, MIN("timestamp") AS first_seen
        FROM user_lp_position_updated_events
        WHERE signer = ANY($1::text[])
        GROUP BY signer
        UNION ALL
        SELECT signer, MIN(event_timestamp) AS first_seen
        FROM user_position_updated_events
        WHERE signer = ANY($1::text[])
        GROUP BY signer
      ) activity
      GROUP BY signer
    `,
    [users]
  );

  return new Map(result.rows.map((row) => [row.signer, floorToHour(new Date(row.first_seen))]));
}

export async function backfillPortfolioSnapshots(
  db: Queryable,
  options: PortfolioSnapshotBackfillOptions = {}
): Promise<PortfolioSnapshotBackfillResult> {
  const dryRun = Boolean(options.dryRun);
  const users = await fetchActivePortfolioUsers(db, options);
  const from = floorToHour(options.from ?? await defaultBackfillStart(db));
  const to = floorToHour(options.to ?? new Date());
  const maxBucketsPerUser = options.maxBucketsPerUser ?? Number.POSITIVE_INFINITY;
  const priceCache = options.priceCache ?? createHistoricalTokenPriceCache();
  const concurrency = Math.min(Math.max(options.concurrency ?? 1, 1), 25);
  const firstActivityBuckets = options.startAtFirstActivity
    ? await fetchUserFirstActivityBuckets(db, users)
    : new Map<string, Date>();

  let buckets = 0;
  let written = 0;
  let nextUserIndex = 0;

  async function processUser(user: string): Promise<void> {
    const userFrom = firstActivityBuckets.get(user);
    let bucket = userFrom && userFrom > from ? new Date(userFrom) : new Date(from);
    let userBuckets = 0;
    const existingBuckets = options.skipExisting
      ? await fetchExistingSnapshotBuckets(db, user, bucket, to)
      : new Set<number>();

    while (bucket <= to && userBuckets < maxBucketsPerUser) {
      if (existingBuckets.has(bucket.getTime())) {
        bucket = new Date(bucket.getTime() + 60 * 60 * 1000);
        continue;
      }

      const values = await computePortfolioSnapshotValues(db, user, bucket, {
        historical: bucket < floorToHour(new Date()),
        dryRun,
        priceCache,
      });

      buckets += 1;
      userBuckets += 1;

      if (!dryRun) {
        await upsertPortfolioSnapshot(db, user, bucket, values, 'backfill');
        written += 1;
      }

      if (options.progressEveryBuckets && buckets % options.progressEveryBuckets === 0) {
        console.log(`Portfolio snapshot progress: buckets=${buckets}, written=${written}, currentUser=${user}, bucket=${bucket.toISOString()}`);
      }

      bucket = new Date(bucket.getTime() + 60 * 60 * 1000);
    }
  }

  async function worker(): Promise<void> {
    while (nextUserIndex < users.length) {
      const user = users[nextUserIndex];
      nextUserIndex += 1;
      await processUser(user);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, users.length) }, () => worker()));

  return {
    users: users.length,
    buckets,
    written,
    dryRun,
  };
}

export async function snapshotCurrentActiveUsers(
  db: Queryable,
  options: { userAddress?: string; limitUsers?: number; dryRun?: boolean } = {}
): Promise<PortfolioSnapshotBackfillResult> {
  const users = await fetchActivePortfolioUsers(db, options);
  const bucket = floorToHour(new Date());
  let written = 0;

  for (const user of users) {
    const values = await computePortfolioSnapshotValues(db, user, bucket, {
      historical: false,
      dryRun: Boolean(options.dryRun),
    });
    if (!options.dryRun) {
      await upsertPortfolioSnapshot(db, user, bucket, values, 'snapshotter');
      written += 1;
    }
  }

  return {
    users: users.length,
    buckets: users.length,
    written,
    dryRun: Boolean(options.dryRun),
  };
}
