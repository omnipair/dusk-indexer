import { QueryResult, QueryResultRow } from 'pg';
import { getHistoricalTokenPrices } from './tokenPriceSnapshotService';
import {
  ActiveLpPosition,
  LpEarningSource,
  allocateLpEarning,
  parseNumber,
} from '../utils/portfolioMath';

interface Queryable {
  query<T extends QueryResultRow = any>(text: string, params?: any[]): Promise<QueryResult<T>>;
}

export interface LpEarningsBackfillOptions {
  dryRun?: boolean;
  limit?: number;
  maxEvents?: number;
  pair?: string;
  source?: LpEarningSource;
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
        FROM lp_position_earning_events existing
        WHERE existing.pair = event_rows.pair
          AND existing.source = event_rows.source
          AND existing.source_event_id = event_rows.source_event_id
      )
      AND EXISTS (
        SELECT 1
        FROM (
          SELECT DISTINCT ON (lp.signer)
            lp.signer,
            lp.lp_amount
          FROM user_lp_position_updated_events lp
          WHERE lp.pair_address = event_rows.pair
            AND lp.slot <= event_rows.event_slot::numeric
          ORDER BY lp.signer, lp.slot DESC, lp."timestamp" DESC, lp.id DESC
        ) active_lp
        WHERE active_lp.lp_amount > 0
      )
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

async function fetchActiveLpPositions(
  db: Queryable,
  pair: string,
  eventSlot: number
): Promise<ActiveLpPosition[]> {
  const result = await db.query<ActivePositionRow>(
    `
      SELECT DISTINCT ON (signer)
        signer,
        lp_amount::text AS lp_amount
      FROM user_lp_position_updated_events
      WHERE pair_address = $1
        AND slot <= $2::numeric
      ORDER BY signer, slot DESC, "timestamp" DESC, id DESC
    `,
    [pair, eventSlot]
  );

  return result.rows.map((row) => ({
    signer: row.signer,
    lpAmount: parseNumber(row.lp_amount),
  }));
}

async function fetchTotalSupply(db: Queryable, pair: string, eventSlot: number): Promise<number> {
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
        AND slot <= $2::numeric
    `,
    [pair, eventSlot]
  );

  return parseNumber(result.rows[0]?.total_supply);
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
  dryRun: boolean
): Promise<number> {
  const eventSlot = parseNumber(event.event_slot, -1);
  if (eventSlot < 0) {
    return 0;
  }

  const pairTokens = await fetchPairTokens(db, event.pair);
  if (!pairTokens) {
    return 0;
  }

  const [activePositions, totalSupply, prices] = await Promise.all([
    fetchActiveLpPositions(db, event.pair, eventSlot),
    fetchTotalSupply(db, event.pair, eventSlot),
    getHistoricalTokenPrices(
      db,
      [pairTokens.token0, pairTokens.token1],
      new Date(event.event_timestamp),
      { dryRun, allowCurrentFallback: true }
    ),
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
    return allocations.length;
  }

  for (const allocation of allocations) {
    await db.query(
      `
        INSERT INTO lp_position_earning_events (
          pair, signer, source, source_event_id, source_tx_sig,
          event_slot, event_timestamp, lp_amount, total_supply, lp_share,
          token0_amount, token1_amount, token0_usd, token1_usd, total_usd,
          price_quality
        ) VALUES (
          $1, $2, $3, $4, $5,
          $6, $7, $8, $9, $10,
          $11, $12, $13, $14, $15,
          $16
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
          price_quality = EXCLUDED.price_quality
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
      ]
    );
  }

  await refreshLpEarningsAggregate(db, event.pair, allocations.map((allocation) => allocation.signer));
  return allocations.length;
}

export async function backfillLpEarnings(
  db: Queryable,
  options: LpEarningsBackfillOptions = {}
): Promise<LpEarningsBackfillResult> {
  const dryRun = Boolean(options.dryRun);
  const maxEvents = options.maxEvents ?? Number.POSITIVE_INFINITY;
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

    for (const event of events) {
      scannedEvents += 1;
      const allocations = await allocateAndPersistEvent(db, event, dryRun);
      allocatedRows += allocations;
      if (allocations === 0) {
        skippedEvents += 1;
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
