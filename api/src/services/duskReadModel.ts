/**
 * Read model over the Dusk ingestion tables.
 *
 * Everything here is derived from indexed events — the daemon records what
 * the programs emitted, and these queries aggregate that. Nothing is read
 * from chain: an endpoint that needs current account state (pool reserves,
 * utilization, a position's live health) does not belong here until the
 * daemon projects account snapshots.
 */

import pool from '../config/database';

export interface DuskEventRow {
  time: string;
  eventName: string;
  market: string | null;
  signature: string;
  slot: string;
  payload: unknown;
}

export interface DuskMarketRow {
  market: string;
  firstSeen: string;
  lastActivity: string;
  eventCount: number;
  createdSignature: string | null;
  createdPayload: unknown;
}

export interface DuskPagination {
  limit: number;
  offset: number;
  total: number;
}

const MAX_LIMIT = 500;

export function boundedLimit(raw: unknown, fallback = 100): number {
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, MAX_LIMIT);
}

export function boundedOffset(raw: unknown): number {
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return 0;
  return parsed;
}

function mapEvent(row: {
  time: Date;
  event_name: string;
  market: string | null;
  transaction_signature: string;
  slot: string;
  payload: unknown;
}): DuskEventRow {
  return {
    time: row.time.toISOString(),
    eventName: row.event_name,
    market: row.market,
    signature: row.transaction_signature,
    slot: String(row.slot),
    payload: row.payload,
  };
}

export async function listMarkets(
  cluster: string,
  limit: number,
  offset: number,
): Promise<{ markets: DuskMarketRow[]; pagination: DuskPagination }> {
  const totals = await pool.query<{ total: string }>(
    `SELECT count(DISTINCT market)::text AS total
       FROM dusk_ingestion.event_stream
      WHERE cluster = $1 AND market IS NOT NULL`,
    [cluster],
  );

  const rows = await pool.query(
    `WITH activity AS (
         SELECT market,
                min(time) AS first_seen,
                max(time) AS last_activity,
                count(*)::int AS event_count
           FROM dusk_ingestion.event_stream
          WHERE cluster = $1 AND market IS NOT NULL
          GROUP BY market
     ),
     created AS (
         SELECT DISTINCT ON (market)
                market, transaction_signature, payload
           FROM dusk_ingestion.event_stream
          WHERE cluster = $1 AND market IS NOT NULL
            AND event_name = 'MarketCreated'
          ORDER BY market, time ASC
     )
     SELECT activity.market,
            activity.first_seen,
            activity.last_activity,
            activity.event_count,
            created.transaction_signature,
            created.payload
       FROM activity
       LEFT JOIN created ON created.market = activity.market
      ORDER BY activity.last_activity DESC
      LIMIT $2 OFFSET $3`,
    [cluster, limit, offset],
  );

  return {
    markets: rows.rows.map((row) => ({
      market: row.market,
      firstSeen: row.first_seen.toISOString(),
      lastActivity: row.last_activity.toISOString(),
      eventCount: row.event_count,
      createdSignature: row.transaction_signature ?? null,
      createdPayload: row.payload ?? null,
    })),
    pagination: {
      limit,
      offset,
      total: Number(totals.rows[0]?.total ?? 0),
    },
  };
}

export async function marketDetail(
  cluster: string,
  market: string,
): Promise<{
  market: string;
  firstSeen: string;
  lastActivity: string;
  eventCount: number;
  eventCounts: Record<string, number>;
} | null> {
  const rows = await pool.query(
    `SELECT event_name,
            count(*)::int AS event_count,
            min(time) AS first_seen,
            max(time) AS last_activity
       FROM dusk_ingestion.event_stream
      WHERE cluster = $1 AND market = $2
      GROUP BY event_name`,
    [cluster, market],
  );
  if (rows.rowCount === 0) return null;

  const eventCounts: Record<string, number> = {};
  let total = 0;
  let firstSeen = rows.rows[0].first_seen as Date;
  let lastActivity = rows.rows[0].last_activity as Date;
  for (const row of rows.rows) {
    eventCounts[row.event_name] = row.event_count;
    total += row.event_count;
    if (row.first_seen < firstSeen) firstSeen = row.first_seen;
    if (row.last_activity > lastActivity) lastActivity = row.last_activity;
  }

  return {
    market,
    firstSeen: firstSeen.toISOString(),
    lastActivity: lastActivity.toISOString(),
    eventCount: total,
    eventCounts,
  };
}

export async function listEvents(
  cluster: string,
  options: {
    market?: string;
    eventNames?: string[];
    since?: string;
    until?: string;
    limit: number;
    offset: number;
  },
): Promise<{ events: DuskEventRow[]; pagination: DuskPagination }> {
  const filters: string[] = ['cluster = $1'];
  const values: unknown[] = [cluster];

  if (options.market) {
    values.push(options.market);
    filters.push(`market = $${values.length}`);
  }
  if (options.eventNames?.length) {
    values.push(options.eventNames);
    filters.push(`event_name = ANY($${values.length})`);
  }
  if (options.since) {
    values.push(options.since);
    filters.push(`time >= $${values.length}::timestamptz`);
  }
  if (options.until) {
    values.push(options.until);
    filters.push(`time <= $${values.length}::timestamptz`);
  }
  const where = filters.join(' AND ');

  const totals = await pool.query<{ total: string }>(
    `SELECT count(*)::text AS total FROM dusk_ingestion.event_stream WHERE ${where}`,
    values,
  );

  values.push(options.limit, options.offset);
  const rows = await pool.query(
    `SELECT time, event_name, market, transaction_signature, slot, payload
       FROM dusk_ingestion.event_stream
      WHERE ${where}
      ORDER BY time DESC, slot DESC
      LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values,
  );

  return {
    events: rows.rows.map(mapEvent),
    pagination: {
      limit: options.limit,
      offset: options.offset,
      total: Number(totals.rows[0]?.total ?? 0),
    },
  };
}

export interface DuskIngestionHealth {
  cluster: string;
  eventCount: number;
  marketCount: number;
  latestEventAt: string | null;
  latestSlot: string | null;
  cursor: {
    lastSignature: string | null;
    lastObservedSlot: string | null;
    updatedAt: string | null;
    protocolRevision: string | null;
  } | null;
}

export async function ingestionHealth(
  cluster: string,
): Promise<DuskIngestionHealth> {
  const [stream, cursor] = await Promise.all([
    pool.query(
      `SELECT count(*)::int AS event_count,
              count(DISTINCT market)::int AS market_count,
              max(time) AS latest_event_at,
              max(slot)::text AS latest_slot
         FROM dusk_ingestion.event_stream
        WHERE cluster = $1`,
      [cluster],
    ),
    pool.query(
      `SELECT last_signature, last_observed_slot::text, updated_at, protocol_revision
         FROM dusk_ingestion.ingestion_cursors
        WHERE cluster = $1
        ORDER BY updated_at DESC
        LIMIT 1`,
      [cluster],
    ),
  ]);

  const summary = stream.rows[0];
  const cursorRow = cursor.rows[0];

  return {
    cluster,
    eventCount: summary?.event_count ?? 0,
    marketCount: summary?.market_count ?? 0,
    latestEventAt: summary?.latest_event_at
      ? (summary.latest_event_at as Date).toISOString()
      : null,
    latestSlot: summary?.latest_slot ?? null,
    cursor: cursorRow
      ? {
          lastSignature: cursorRow.last_signature ?? null,
          lastObservedSlot: cursorRow.last_observed_slot ?? null,
          updatedAt: (cursorRow.updated_at as Date).toISOString(),
          protocolRevision: cursorRow.protocol_revision ?? null,
        }
      : null,
  };
}
