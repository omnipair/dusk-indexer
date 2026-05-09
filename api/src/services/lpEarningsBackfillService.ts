import { QueryResult, QueryResultRow } from 'pg';
import {
  HistoricalTokenPriceCache,
  createHistoricalTokenPriceCache,
  getHistoricalTokenPrices,
} from './tokenPriceSnapshotService';
import {
  ActiveLpPosition,
  AllocationQuality,
  LpEarningSource,
  allocateLpEarning,
  parseNumber,
} from '../utils/portfolioMath';

interface Queryable {
  query<T extends QueryResultRow = any>(text: string, params?: any[]): Promise<QueryResult<T>>;
}

interface TransactionClient extends Queryable {
  release(): void;
}

interface TransactionalQueryable extends Queryable {
  connect?: () => Promise<TransactionClient>;
}

export interface LpEarningsBackfillOptions {
  dryRun?: boolean;
  limit?: number;
  maxEvents?: number;
  pair?: string;
  source?: LpEarningSource;
  priceCache?: HistoricalTokenPriceCache;
  progressEvery?: number;
  useBatch?: boolean;
}

export interface LpEarningsBackfillResult {
  scannedEvents: number;
  allocatedRows: number;
  skippedEvents: number;
  dryRun: boolean;
}

interface EarningEventRow {
  source: LpEarningSource;
  source_event_id: string;
  source_tx_sig: string | null;
  pair: string;
  event_slot: string | number | null;
  event_timestamp: Date | string;
  source_instruction_index: string | number | null;
  source_instruction_path: string | null;
  token0_amount: string | null;
  token1_amount: string | null;
}

interface ActivePositionRow {
  signer: string;
  lp_amount: string;
}

interface PairTokenRow {
  token0: string;
  token1: string;
}

interface OrderingQualityRow {
  has_unknown_same_slot_ordering: boolean;
}

interface LpEarningsBackfillContext {
  priceCache: HistoricalTokenPriceCache;
  pairTokenCache: Map<string, PairTokenRow | null>;
}

interface BatchPersistResultRow {
  source_events: number;
  allocated_rows: number;
  skipped_events: number;
}

async function withTransaction<T>(
  db: Queryable,
  handler: (client: Queryable) => Promise<T>
): Promise<T> {
  const transactionalDb = db as TransactionalQueryable;
  if (typeof transactionalDb.connect === 'function') {
    const client = await transactionalDb.connect();
    try {
      await client.query('BEGIN');
      const result = await handler(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  await db.query('BEGIN');
  try {
    const result = await handler(db);
    await db.query('COMMIT');
    return result;
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }
}

async function fetchUnallocatedEarningEvents(
  db: Queryable,
  options: LpEarningsBackfillOptions
): Promise<EarningEventRow[]> {
  const params: any[] = [];
  const filters: string[] = [];
  const sourceFilters: string[] = [];

  if (options.pair) {
    params.push(options.pair);
    filters.push(`event_rows.pair = $${params.length}`);
  }

  if (options.source) {
    params.push(options.source);
    filters.push(`event_rows.source = $${params.length}`);
  }

  params.push(Math.min(Math.max(options.limit ?? 100, 1), 1000));
  const limitParam = `$${params.length}`;

  if (!options.source || options.source === 'borrow_interest') {
    sourceFilters.push(`
      SELECT
        'borrow_interest'::text AS source,
        upe.id::text AS source_event_id,
        upe.transaction_signature AS source_tx_sig,
        upe.pair,
        upe.slot AS event_slot,
        upe."timestamp" AS event_timestamp,
        upe.instruction_index AS source_instruction_index,
        upe.instruction_path AS source_instruction_path,
        COALESCE(upe.lp_interest0, 0)::text AS token0_amount,
        COALESCE(upe.lp_interest1, 0)::text AS token1_amount
      FROM update_pair_events upe
      WHERE COALESCE(upe.lp_interest0, 0) > 0
         OR COALESCE(upe.lp_interest1, 0) > 0
    `);
  }

  if (!options.source || options.source === 'swap_fee') {
    sourceFilters.push(`
      SELECT
        'swap_fee'::text AS source,
        s.id::text AS source_event_id,
        s.tx_sig AS source_tx_sig,
        s.pair,
        s.slot AS event_slot,
        s."timestamp" AS event_timestamp,
        s.instruction_index AS source_instruction_index,
        s.instruction_path AS source_instruction_path,
        CASE WHEN s.is_token0_in THEN COALESCE(s.lp_fee, 0) ELSE 0 END::text AS token0_amount,
        CASE WHEN s.is_token0_in THEN 0 ELSE COALESCE(s.lp_fee, 0) END::text AS token1_amount
      FROM swaps s
      WHERE COALESCE(s.lp_fee, 0) > 0
    `);
  }

  const whereClause = filters.length > 0 ? `AND ${filters.join(' AND ')}` : '';
  const result = await db.query<EarningEventRow>(
    `
      WITH event_rows AS (
        ${sourceFilters.join('\nUNION ALL\n')}
      )
      SELECT event_rows.*
      FROM event_rows
      WHERE NOT EXISTS (
        SELECT 1
        FROM lp_earning_source_events existing
        WHERE existing.pair = event_rows.pair
          AND existing.source = event_rows.source
          AND existing.source_event_id = event_rows.source_event_id
      )
      AND event_rows.event_slot IS NOT NULL
      ${whereClause}
      ORDER BY event_rows.event_timestamp ASC, event_rows.source_event_id ASC
      LIMIT ${limitParam}
    `,
    params
  );

  return result.rows.map((row) => ({
    ...row,
    source: row.source as LpEarningSource,
  }));
}

async function fetchPairTokens(db: Queryable, pair: string): Promise<PairTokenRow | null> {
  const result = await db.query<PairTokenRow>(
    'SELECT token0, token1 FROM pools WHERE pair_address = $1',
    [pair]
  );
  return result.rows[0] ?? null;
}

async function fetchPairTokensCached(
  db: Queryable,
  pair: string,
  cache: Map<string, PairTokenRow | null>
): Promise<PairTokenRow | null> {
  if (cache.has(pair)) {
    return cache.get(pair) ?? null;
  }
  const tokens = await fetchPairTokens(db, pair);
  cache.set(pair, tokens);
  return tokens;
}

async function fetchActiveLpPositions(
  db: Queryable,
  pair: string,
  event: EarningEventRow,
  eventSlot: number
): Promise<ActiveLpPosition[]> {
  const result = await db.query<ActivePositionRow>(
    `
      SELECT DISTINCT ON (signer)
        signer,
        lp_amount::text AS lp_amount
      FROM user_lp_position_updated_events
      WHERE pair_address = $1
        AND (
          slot < $2::numeric
          OR (
            slot = $2::numeric
            AND transaction_signature = $3
            AND instruction_path IS NOT NULL
            AND $4::text IS NOT NULL
            AND instruction_path < $4
          )
        )
      ORDER BY signer, slot DESC, instruction_path DESC NULLS LAST, "timestamp" DESC, id DESC
    `,
    [pair, eventSlot, event.source_tx_sig, event.source_instruction_path]
  );

  return result.rows.map((row) => ({
    signer: row.signer,
    lpAmount: parseNumber(row.lp_amount),
  }));
}

async function fetchTotalSupply(
  db: Queryable,
  pair: string,
  event: EarningEventRow,
  eventSlot: number
): Promise<number> {
  const result = await db.query<{ total_supply: string }>(
    `
      SELECT (
        1000 + COALESCE(SUM(
          CASE
            WHEN event_type IN ('add', 'mint') THEN liquidity::numeric
            WHEN event_type IN ('remove', 'burn') THEN -liquidity::numeric
            ELSE 0
          END
        ), 0)
      )::text AS total_supply
      FROM adjust_liquidity
      WHERE pair = $1
        AND (
          slot < $2::numeric
          OR (
            slot = $2::numeric
            AND tx_sig = $3
            AND instruction_path IS NOT NULL
            AND $4::text IS NOT NULL
            AND instruction_path < $4
          )
        )
    `,
    [pair, eventSlot, event.source_tx_sig, event.source_instruction_path]
  );

  return parseNumber(result.rows[0]?.total_supply);
}

async function detectAllocationQuality(
  db: Queryable,
  event: EarningEventRow,
  eventSlot: number
): Promise<AllocationQuality> {
  const result = await db.query<OrderingQualityRow>(
    `
      SELECT EXISTS (
        SELECT 1
        FROM (
          SELECT transaction_signature AS tx_sig, instruction_path
          FROM user_lp_position_updated_events
          WHERE pair_address = $1
            AND slot = $2::numeric
          UNION ALL
          SELECT tx_sig, instruction_path
          FROM adjust_liquidity
          WHERE pair = $1
            AND slot = $2::numeric
        ) same_slot_events
        WHERE $3::text IS NULL
          OR $4::text IS NULL
          OR same_slot_events.tx_sig IS NULL
          OR same_slot_events.tx_sig <> $3
          OR same_slot_events.instruction_path IS NULL
      ) AS has_unknown_same_slot_ordering
    `,
    [event.pair, eventSlot, event.source_tx_sig, event.source_instruction_path]
  );

  return result.rows[0]?.has_unknown_same_slot_ordering ? 'estimated' : 'exact';
}

async function markEarningSourceEventAllocated(
  db: Queryable,
  event: EarningEventRow,
  eventSlot: number,
  allocationCount: number,
  allocationQuality: AllocationQuality
): Promise<void> {
  await db.query(
    `
      INSERT INTO lp_earning_source_events (
        pair, source, source_event_id, source_tx_sig, event_slot, event_timestamp,
        source_instruction_index, source_instruction_path,
        allocation_quality, allocation_count, processed_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8,
        $9, $10, now()
      )
      ON CONFLICT (pair, source, source_event_id) DO UPDATE SET
        source_tx_sig = EXCLUDED.source_tx_sig,
        event_slot = EXCLUDED.event_slot,
        event_timestamp = EXCLUDED.event_timestamp,
        source_instruction_index = EXCLUDED.source_instruction_index,
        source_instruction_path = EXCLUDED.source_instruction_path,
        allocation_quality = EXCLUDED.allocation_quality,
        allocation_count = EXCLUDED.allocation_count,
        processed_at = now()
    `,
    [
      event.pair,
      event.source,
      event.source_event_id,
      event.source_tx_sig,
      eventSlot,
      new Date(event.event_timestamp),
      event.source_instruction_index,
      event.source_instruction_path,
      allocationQuality,
      allocationCount,
    ]
  );
}

async function refreshLpEarningsAggregate(
  db: Queryable,
  pair: string,
  signers: string[]
): Promise<void> {
  if (signers.length === 0) {
    return;
  }

  await db.query(
    `
      INSERT INTO lp_position_earnings (
        pair, signer,
        accrued_interest0, accrued_interest1,
        swap_fees0, swap_fees1,
        accrued_interest_usd, swap_fees_usd,
        total_earned_usd, updated_at
      )
      SELECT
        pair,
        signer,
        COALESCE(SUM(CASE WHEN source = 'borrow_interest' THEN token0_amount ELSE 0 END), 0),
        COALESCE(SUM(CASE WHEN source = 'borrow_interest' THEN token1_amount ELSE 0 END), 0),
        COALESCE(SUM(CASE WHEN source = 'swap_fee' THEN token0_amount ELSE 0 END), 0),
        COALESCE(SUM(CASE WHEN source = 'swap_fee' THEN token1_amount ELSE 0 END), 0),
        COALESCE(SUM(CASE WHEN source = 'borrow_interest' THEN total_usd ELSE 0 END), 0),
        COALESCE(SUM(CASE WHEN source = 'swap_fee' THEN total_usd ELSE 0 END), 0),
        COALESCE(SUM(total_usd), 0),
        now()
      FROM lp_position_earning_events
      WHERE pair = $1
        AND signer = ANY($2::text[])
      GROUP BY pair, signer
      ON CONFLICT (pair, signer) DO UPDATE SET
        accrued_interest0 = EXCLUDED.accrued_interest0,
        accrued_interest1 = EXCLUDED.accrued_interest1,
        swap_fees0 = EXCLUDED.swap_fees0,
        swap_fees1 = EXCLUDED.swap_fees1,
        accrued_interest_usd = EXCLUDED.accrued_interest_usd,
        swap_fees_usd = EXCLUDED.swap_fees_usd,
        total_earned_usd = EXCLUDED.total_earned_usd,
        updated_at = now()
    `,
    [pair, signers]
  );
}

async function allocateAndPersistEvent(
  db: Queryable,
  event: EarningEventRow,
  dryRun: boolean,
  context: LpEarningsBackfillContext
): Promise<number> {
  const eventSlot = parseNumber(event.event_slot, -1);
  if (eventSlot < 0) {
    return 0;
  }

  const pairTokens = await fetchPairTokensCached(db, event.pair, context.pairTokenCache);
  if (!pairTokens) {
    return 0;
  }

  const [activePositions, totalSupply, prices, allocationQuality] = await Promise.all([
    fetchActiveLpPositions(db, event.pair, event, eventSlot),
    fetchTotalSupply(db, event.pair, event, eventSlot),
    getHistoricalTokenPrices(
      db,
      [pairTokens.token0, pairTokens.token1],
      new Date(event.event_timestamp),
      {
        dryRun,
        allowCurrentFallback: true,
        cache: context.priceCache,
      }
    ),
    detectAllocationQuality(db, event, eventSlot),
  ]);

  const allocations = allocateLpEarning(
    activePositions,
    totalSupply,
    parseNumber(event.token0_amount),
    parseNumber(event.token1_amount),
    prices.get(pairTokens.token0),
    prices.get(pairTokens.token1)
  );

  if (dryRun || allocations.length === 0) {
    if (!dryRun && allocations.length === 0) {
      await withTransaction(db, (client) =>
        markEarningSourceEventAllocated(client, event, eventSlot, 0, allocationQuality)
      );
    }
    return allocations.length;
  }

  await withTransaction(db, async (client) => {
    for (const allocation of allocations) {
      await client.query(
        `
          INSERT INTO lp_position_earning_events (
            pair, signer, source, source_event_id, source_tx_sig,
            event_slot, event_timestamp, lp_amount, total_supply, lp_share,
            token0_amount, token1_amount, token0_usd, token1_usd, total_usd,
            price_quality, allocation_quality, source_instruction_index, source_instruction_path,
            updated_at
          ) VALUES (
            $1, $2, $3, $4, $5,
            $6, $7, $8, $9, $10,
            $11, $12, $13, $14, $15,
            $16, $17, $18, $19,
            now()
          )
          ON CONFLICT (pair, signer, source, source_event_id) DO UPDATE SET
            source_tx_sig = EXCLUDED.source_tx_sig,
            event_slot = EXCLUDED.event_slot,
            event_timestamp = EXCLUDED.event_timestamp,
            lp_amount = EXCLUDED.lp_amount,
            total_supply = EXCLUDED.total_supply,
            lp_share = EXCLUDED.lp_share,
            token0_amount = EXCLUDED.token0_amount,
            token1_amount = EXCLUDED.token1_amount,
            token0_usd = EXCLUDED.token0_usd,
            token1_usd = EXCLUDED.token1_usd,
            total_usd = EXCLUDED.total_usd,
            price_quality = EXCLUDED.price_quality,
            allocation_quality = EXCLUDED.allocation_quality,
            source_instruction_index = EXCLUDED.source_instruction_index,
            source_instruction_path = EXCLUDED.source_instruction_path,
            updated_at = now()
        `,
        [
          event.pair,
          allocation.signer,
          event.source,
          event.source_event_id,
          event.source_tx_sig,
          eventSlot,
          new Date(event.event_timestamp),
          allocation.lpAmount,
          allocation.totalSupply,
          allocation.lpShare,
          allocation.token0Amount,
          allocation.token1Amount,
          allocation.token0Usd,
          allocation.token1Usd,
          allocation.totalUsd,
          allocation.priceQuality,
          allocationQuality,
          event.source_instruction_index,
          event.source_instruction_path,
        ]
      );
    }

    await refreshLpEarningsAggregate(client, event.pair, allocations.map((allocation) => allocation.signer));
    await markEarningSourceEventAllocated(
      client,
      event,
      eventSlot,
      allocations.length,
      allocationQuality
    );
  });
  return allocations.length;
}

async function allocateAndPersistEventsBatch(
  db: Queryable,
  events: EarningEventRow[]
): Promise<{ sourceEvents: number; allocatedRows: number; skippedEvents: number }> {
  if (events.length === 0) {
    return { sourceEvents: 0, allocatedRows: 0, skippedEvents: 0 };
  }

  const eventPayload = events.map((event) => ({
    source: event.source,
    source_event_id: event.source_event_id,
    source_tx_sig: event.source_tx_sig,
    pair: event.pair,
    event_slot: event.event_slot === null ? null : String(event.event_slot),
    event_timestamp: new Date(event.event_timestamp).toISOString(),
    source_instruction_index: event.source_instruction_index === null
      ? null
      : Number(event.source_instruction_index),
    source_instruction_path: event.source_instruction_path,
    token0_amount: event.token0_amount ?? '0',
    token1_amount: event.token1_amount ?? '0',
  }));

  const result = await withTransaction(db, async (client) => client.query<BatchPersistResultRow>(
    `
      WITH event_rows AS (
        SELECT
          source::text,
          source_event_id::text,
          source_tx_sig::text,
          pair::text,
          event_slot::numeric,
          event_timestamp::timestamptz,
          source_instruction_index::integer,
          source_instruction_path::text,
          token0_amount::numeric,
          token1_amount::numeric
        FROM jsonb_to_recordset($1::jsonb) AS events(
          source text,
          source_event_id text,
          source_tx_sig text,
          pair text,
          event_slot text,
          event_timestamp text,
          source_instruction_index integer,
          source_instruction_path text,
          token0_amount text,
          token1_amount text
        )
      ),
      allocation_rows AS (
        SELECT
          event_rows.pair,
          active_lp.signer,
          event_rows.source,
          event_rows.source_event_id,
          event_rows.source_tx_sig,
          event_rows.event_slot,
          event_rows.event_timestamp,
          active_lp.lp_amount,
          supply.total_supply,
          active_lp.lp_amount / supply.total_supply AS lp_share,
          event_rows.token0_amount * active_lp.lp_amount / supply.total_supply AS allocated_token0,
          event_rows.token1_amount * active_lp.lp_amount / supply.total_supply AS allocated_token1,
          COALESCE(price0.price_usd, 0) AS token0_price_usd,
          COALESCE(price1.price_usd, 0) AS token1_price_usd,
          COALESCE(price0.decimals, 6) AS token0_decimals,
          COALESCE(price1.decimals, 6) AS token1_decimals,
          CASE
            WHEN price0.quality = 'missing'
              OR price1.quality = 'missing'
              OR price0.quality IS NULL
              OR price1.quality IS NULL
              THEN 'missing'
            WHEN price0.quality = 'estimated'
              OR price1.quality = 'estimated'
              THEN 'estimated'
            ELSE COALESCE(price0.quality, price1.quality, 'missing')
          END AS price_quality,
          CASE
            WHEN EXISTS (
              SELECT 1
              FROM (
                SELECT transaction_signature AS tx_sig, instruction_path
                FROM user_lp_position_updated_events
                WHERE pair_address = event_rows.pair
                  AND slot = event_rows.event_slot
                UNION ALL
                SELECT tx_sig, instruction_path
                FROM adjust_liquidity
                WHERE pair = event_rows.pair
                  AND slot = event_rows.event_slot
              ) same_slot_events
              WHERE event_rows.source_tx_sig IS NULL
                OR event_rows.source_instruction_path IS NULL
                OR same_slot_events.tx_sig IS NULL
                OR same_slot_events.tx_sig <> event_rows.source_tx_sig
                OR same_slot_events.instruction_path IS NULL
            ) THEN 'estimated'
            ELSE 'exact'
          END AS allocation_quality,
          event_rows.source_instruction_index,
          event_rows.source_instruction_path
        FROM event_rows
        JOIN pools ON pools.pair_address = event_rows.pair
        JOIN LATERAL (
          SELECT DISTINCT ON (lp.signer)
            lp.signer,
            lp.lp_amount::numeric AS lp_amount
          FROM user_lp_position_updated_events lp
          WHERE lp.pair_address = event_rows.pair
            AND (
              lp.slot < event_rows.event_slot
              OR (
                lp.slot = event_rows.event_slot
                AND lp.transaction_signature = event_rows.source_tx_sig
                AND lp.instruction_path IS NOT NULL
                AND event_rows.source_instruction_path IS NOT NULL
                AND lp.instruction_path < event_rows.source_instruction_path
              )
            )
          ORDER BY lp.signer, lp.slot DESC, lp.instruction_path DESC NULLS LAST, lp."timestamp" DESC, lp.id DESC
        ) active_lp ON active_lp.lp_amount > 0
        JOIN LATERAL (
          SELECT (
            1000 + COALESCE(SUM(
              CASE
                WHEN event_type IN ('add', 'mint') THEN liquidity::numeric
                WHEN event_type IN ('remove', 'burn') THEN -liquidity::numeric
                ELSE 0
              END
            ), 0)
          )::numeric AS total_supply
          FROM adjust_liquidity
          WHERE pair = event_rows.pair
            AND (
              slot < event_rows.event_slot
              OR (
                slot = event_rows.event_slot
                AND tx_sig = event_rows.source_tx_sig
                AND instruction_path IS NOT NULL
                AND event_rows.source_instruction_path IS NOT NULL
                AND instruction_path < event_rows.source_instruction_path
              )
            )
        ) supply ON supply.total_supply > 0
        LEFT JOIN token_price_snapshots price0
          ON price0.mint = pools.token0
         AND price0.bucket = date_trunc('hour', event_rows.event_timestamp)
         AND price0.provider = 'birdeye'
        LEFT JOIN token_price_snapshots price1
          ON price1.mint = pools.token1
         AND price1.bucket = date_trunc('hour', event_rows.event_timestamp)
         AND price1.provider = 'birdeye'
      ),
      allocations AS (
        SELECT
          *,
          allocated_token0 / power(10::numeric, token0_decimals) * token0_price_usd AS token0_usd,
          allocated_token1 / power(10::numeric, token1_decimals) * token1_price_usd AS token1_usd
        FROM allocation_rows
      ),
      upsert_earning_events AS (
        INSERT INTO lp_position_earning_events (
          pair, signer, source, source_event_id, source_tx_sig,
          event_slot, event_timestamp, lp_amount, total_supply, lp_share,
          token0_amount, token1_amount, token0_usd, token1_usd, total_usd,
          price_quality, allocation_quality, source_instruction_index, source_instruction_path,
          updated_at
        )
        SELECT
          pair,
          signer,
          source,
          source_event_id,
          source_tx_sig,
          event_slot,
          event_timestamp,
          lp_amount,
          total_supply,
          lp_share,
          allocated_token0,
          allocated_token1,
          token0_usd,
          token1_usd,
          token0_usd + token1_usd,
          price_quality,
          allocation_quality,
          source_instruction_index,
          source_instruction_path,
          now()
        FROM allocations
        ON CONFLICT (pair, signer, source, source_event_id) DO UPDATE SET
          source_tx_sig = EXCLUDED.source_tx_sig,
          event_slot = EXCLUDED.event_slot,
          event_timestamp = EXCLUDED.event_timestamp,
          lp_amount = EXCLUDED.lp_amount,
          total_supply = EXCLUDED.total_supply,
          lp_share = EXCLUDED.lp_share,
          token0_amount = EXCLUDED.token0_amount,
          token1_amount = EXCLUDED.token1_amount,
          token0_usd = EXCLUDED.token0_usd,
          token1_usd = EXCLUDED.token1_usd,
          total_usd = EXCLUDED.total_usd,
          price_quality = EXCLUDED.price_quality,
          allocation_quality = EXCLUDED.allocation_quality,
          source_instruction_index = EXCLUDED.source_instruction_index,
          source_instruction_path = EXCLUDED.source_instruction_path,
          updated_at = now()
        RETURNING pair, signer
      ),
      allocation_counts AS (
        SELECT
          pair,
          source,
          source_event_id,
          COUNT(*)::integer AS allocation_count,
          CASE
            WHEN BOOL_OR(allocation_quality = 'estimated') THEN 'estimated'
            ELSE 'exact'
          END AS allocation_quality
        FROM allocations
        GROUP BY pair, source, source_event_id
      ),
      upsert_source_events AS (
        INSERT INTO lp_earning_source_events (
          pair, source, source_event_id, source_tx_sig, event_slot, event_timestamp,
          source_instruction_index, source_instruction_path,
          allocation_quality, allocation_count, processed_at
        )
        SELECT
          event_rows.pair,
          event_rows.source,
          event_rows.source_event_id,
          event_rows.source_tx_sig,
          event_rows.event_slot,
          event_rows.event_timestamp,
          event_rows.source_instruction_index,
          event_rows.source_instruction_path,
          COALESCE(allocation_counts.allocation_quality, 'estimated'),
          COALESCE(allocation_counts.allocation_count, 0),
          now()
        FROM event_rows
        LEFT JOIN allocation_counts
          ON allocation_counts.pair = event_rows.pair
         AND allocation_counts.source = event_rows.source
         AND allocation_counts.source_event_id = event_rows.source_event_id
        ON CONFLICT (pair, source, source_event_id) DO UPDATE SET
          source_tx_sig = EXCLUDED.source_tx_sig,
          event_slot = EXCLUDED.event_slot,
          event_timestamp = EXCLUDED.event_timestamp,
          source_instruction_index = EXCLUDED.source_instruction_index,
          source_instruction_path = EXCLUDED.source_instruction_path,
          allocation_quality = EXCLUDED.allocation_quality,
          allocation_count = EXCLUDED.allocation_count,
          processed_at = now()
        RETURNING pair, source, source_event_id, allocation_count
      ),
      affected_positions AS (
        SELECT DISTINCT pair, signer
        FROM upsert_earning_events
      ),
      refresh_aggregate AS (
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
        JOIN affected_positions
          ON affected_positions.pair = earning_events.pair
         AND affected_positions.signer = earning_events.signer
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
      SELECT
        (SELECT COUNT(*) FROM event_rows)::integer AS source_events,
        (SELECT COUNT(*) FROM allocations)::integer AS allocated_rows,
        (SELECT COUNT(*) FROM upsert_source_events WHERE allocation_count = 0)::integer AS skipped_events
    `,
    [JSON.stringify(eventPayload)]
  ));

  const row = result.rows[0];
  return {
    sourceEvents: row?.source_events ?? events.length,
    allocatedRows: row?.allocated_rows ?? 0,
    skippedEvents: row?.skipped_events ?? 0,
  };
}

export async function backfillLpEarnings(
  db: Queryable,
  options: LpEarningsBackfillOptions = {}
): Promise<LpEarningsBackfillResult> {
  const dryRun = Boolean(options.dryRun);
  const maxEvents = options.maxEvents ?? Number.POSITIVE_INFINITY;
  const context: LpEarningsBackfillContext = {
    priceCache: options.priceCache ?? createHistoricalTokenPriceCache(),
    pairTokenCache: new Map(),
  };
  let scannedEvents = 0;
  let allocatedRows = 0;
  let skippedEvents = 0;

  while (scannedEvents < maxEvents) {
    const remaining = maxEvents === Number.POSITIVE_INFINITY
      ? options.limit
      : Math.min(options.limit ?? 100, maxEvents - scannedEvents);
    const events = await fetchUnallocatedEarningEvents(db, {
      ...options,
      limit: remaining,
    });

    if (events.length === 0) {
      break;
    }

    if (!dryRun && options.useBatch !== false) {
      const batchResult = await allocateAndPersistEventsBatch(db, events);
      scannedEvents += batchResult.sourceEvents;
      allocatedRows += batchResult.allocatedRows;
      skippedEvents += batchResult.skippedEvents;
      if (options.progressEvery && scannedEvents % options.progressEvery === 0) {
        console.log(`LP earnings progress: scanned=${scannedEvents}, allocatedRows=${allocatedRows}, skipped=${skippedEvents}`);
      }
      if (events.length < (remaining ?? events.length)) {
        break;
      }
      continue;
    }

    for (const event of events) {
      scannedEvents += 1;
      const allocations = await allocateAndPersistEvent(db, event, dryRun, context);
      allocatedRows += allocations;
      if (allocations === 0) {
        skippedEvents += 1;
      }
      if (options.progressEvery && scannedEvents % options.progressEvery === 0) {
        console.log(`LP earnings progress: scanned=${scannedEvents}, allocatedRows=${allocatedRows}, skipped=${skippedEvents}`);
      }
      if (scannedEvents >= maxEvents) {
        break;
      }
    }

    if (dryRun || events.length < (remaining ?? events.length)) {
      break;
    }
  }

  return {
    scannedEvents,
    allocatedRows,
    skippedEvents,
    dryRun,
  };
}
