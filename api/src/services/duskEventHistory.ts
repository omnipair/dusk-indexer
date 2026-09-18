import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { PoolClient } from 'pg';
import pool from '../config/database';
import { loadPinnedProtocol } from '../config/duskProtocol';
import { timedClientQuery } from '../utils/dbQuery';
import { perfMetrics } from '../utils/perfMetrics';
import { QuoteCache } from './duskQuoteCache';

export const HISTORY_EVENTS = [
  'SwapExecuted', 'LiquidityAdded', 'LiquidityRemoved',
  'MarketCollateralDeposited', 'MarketCollateralWithdrawn', 'MarketDebtUpdated',
  'BorrowPositionLiquidated', 'LeveragePositionOpened', 'LeveragePositionUpdated',
  'LeveragePositionClosed', 'LeveragePositionLiquidated',
] as const;
export const LEVERAGE_CLOSE_EVENTS = ['LeveragePositionClosed', 'LeveragePositionLiquidated'] as const;
/** Opt-in preserves v1 event coverage and cursor identity during a rolling release. */
export const HISTORY_EVENTS_V2 = [...HISTORY_EVENTS, 'HlpOpened', 'HlpClosed', 'YieldClaimed'] as const;

export interface EventHistoryQuery {
  version?: 1 | 2;
  owner?: string;
  category?: 'leverage-close' | 'activity';
  market?: string;
  since?: string;
  until: string;
  limit: number;
  cursor?: string;
  deploymentIdentitySha256: string;
}
type Cursor = { scope: string; watermark: string; slot: string; key: string };
const invalid = (): never => { throw Object.assign(new Error('Invalid native event-history query or cursor'), { status: 400 }); };
const integer = (value: unknown): value is string => typeof value === 'string' && /^(0|[1-9]\d{0,18})$/.test(value) && BigInt(value) <= (1n << 63n) - 1n;

/** CanonicalEventKey::stable_key from dusk-ingestion, not a payload hash. */
function canonicalCursorKey(value: unknown, identity: string[]): value is string {
  if (typeof value !== 'string' || value.length > 1024) return false;
  const parts = value.split('|');
  if (parts.length !== 7 || identity.some((part, index) => parts[index] !== part)
    || !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(parts[4])) return false;
  const u16 = (part: string) => /^(0|[1-9]\d{0,4})$/.test(part) && Number(part) <= 65535;
  const path = parts[5].split('.');
  return path.length <= 64 && path.every(u16) && u16(parts[6]);
}

export function eventHistorySelection(query: EventHistoryQuery) {
  const pin = loadPinnedProtocol();
  if (query.version !== undefined && query.version !== 1 && query.version !== 2) invalid();
  const supportedEvents = query.version === 2 ? HISTORY_EVENTS_V2 : HISTORY_EVENTS;
  if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 500
    || !/^[0-9a-f]{64}$/.test(query.deploymentIdentitySha256)
    || !Number.isFinite(Date.parse(query.until)) || Date.parse(query.until) > Date.now()
    || query.since !== undefined && (!Number.isFinite(Date.parse(query.since)) || Date.parse(query.since) > Date.parse(query.until))) invalid();
  if ((query.owner !== undefined) !== (query.category !== undefined)
    || query.category !== undefined && !['leverage-close', 'activity'].includes(query.category)
    || query.category === 'activity' && query.version !== 2) invalid();
  for (const address of [query.market, query.owner]) {
    if (address !== undefined) {
      try { if (new PublicKey(address).toBase58() !== address) invalid(); } catch { invalid(); }
    }
  }
  const identity = [pin.cluster, pin.dusk.programId, pin.dusk.idlCanonicalSha256, pin.revision];
  const window = { market: query.market ?? null, since: query.since ? new Date(query.since).toISOString() : null, until: new Date(query.until).toISOString(),
    ...(query.owner ? { owner: query.owner, category: query.category } : {}) };
  const scope = createHash('sha256').update(JSON.stringify([identity, query.deploymentIdentitySha256, window, supportedEvents])).digest('hex');
  let cursor: Cursor | null = null;
  if (query.cursor !== undefined) {
    try {
      if (query.cursor.length > 2048 || !/^[\w-]+$/.test(query.cursor)) invalid();
      cursor = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8'));
      if (!cursor || cursor.scope !== scope || !integer(cursor.watermark) || !integer(cursor.slot)
        || BigInt(cursor.slot) < BigInt(pin.historyFirstSlot) || !canonicalCursorKey(cursor.key, identity)) invalid();
    } catch { invalid(); }
  }
  return { pin, identity, window, scope, cursor, supportedEvents };
}

type Source = {
  event_key: string; observation_id: string; event_name: string; signature: string;
  slot: string; blockhash: string; instruction_path: number[]; event_ordinal: number;
  payload: Record<string, unknown>; block_time: Date; stream_count: string; matching_count: string;
};

export type EventHistoryState = { revision: string; watermark: string; conflicted: boolean };

export async function eventHistoryState(client: PoolClient, identity: string[]): Promise<EventHistoryState> {
  const result = await timedClientQuery<EventHistoryState>(client, 'dusk.history.events.state',
    `SELECT revision::text,conflicted,COALESCE((
      SELECT observation_id FROM dusk_ingestion.event_observations
      WHERE cluster=$1 AND program_id=$2 AND idl_hash=$3 AND protocol_revision=$4
      ORDER BY observation_id DESC LIMIT 1),0)::text AS watermark
      FROM dusk_ingestion.event_history_state
      WHERE cluster=$1 AND program_id=$2 AND idl_hash=$3 AND protocol_revision=$4`, identity);
  const state = result.rows[0] ?? {revision:'0',watermark:'0',conflicted:false};
  if (state.conflicted) throw new Error('FINALIZED_INVARIANT: contradictory event-history observations');
  return state;
}

/** Indexable actor and liquidator branches; one receipt even when both roles match. */
export function buildEventHistoryQuery(query: EventHistoryQuery, watermark: string) {
  const {identity,window,cursor,supportedEvents} = eventHistorySelection(query);
  const params: unknown[] = [...identity, watermark,
    query.category === 'leverage-close' ? LEVERAGE_CLOSE_EVENTS : supportedEvents,
    window.since,window.until,query.limit+1];
  const bind = (value: unknown) => {params.push(value);return `$${params.length}`;};
  const conditions = [
    `o.cluster=$1 AND o.program_id=$2 AND o.idl_hash=$3 AND o.protocol_revision=$4`,
    `o.commitment='finalized' AND o.observation_id<=$5::bigint AND o.event_name=ANY($6::text[])`,
  ];
  if (window.market) conditions.push(`o.decoded_payload->>'market'=${bind(window.market)}`);
  if (cursor) conditions.push(`(o.slot,o.event_key)<(${bind(cursor.slot)}::bigint,${bind(cursor.key)}::text)`);
  const actor = 'dusk_ingestion.event_history_actor(o.event_name,o.decoded_payload)';
  const where = conditions.join(' AND ');
  const branches = [where];
  if (query.owner) {
    const owner = bind(query.owner);
    branches[0] += ` AND ${actor}=${owner}`;
    if (query.category === 'activity') branches.push(
      `${where} AND o.event_name IN ('BorrowPositionLiquidated','LeveragePositionLiquidated')
        AND o.decoded_payload->>'liquidator'=${owner} AND ${actor} IS DISTINCT FROM o.decoded_payload->>'liquidator'`);
  }
  const select = (filter: string) => `SELECT c.event_key,o.observation_id::text,o.event_name,
      o.transaction_signature AS signature,o.slot::text,o.slot AS sort_slot,o.blockhash,o.instruction_path,o.event_ordinal,
      o.decoded_payload AS payload,history.block_time,history.stream_count,history.matching_count
    FROM dusk_ingestion.event_observations o
    JOIN dusk_ingestion.canonical_events c USING(cluster,program_id,idl_hash,protocol_revision,event_key,observation_id)
    LEFT JOIN LATERAL (SELECT min(s.time) AS block_time,count(*)::text AS stream_count,
      count(*) FILTER(WHERE s.event_name=o.event_name AND s.slot=o.slot AND s.transaction_signature=o.transaction_signature
        AND s.market=o.decoded_payload->>'market' AND s.payload=o.decoded_payload)::text AS matching_count
      FROM dusk_ingestion.event_stream s WHERE
        (s.cluster,s.program_id,s.idl_hash,s.protocol_revision,s.event_key)=(c.cluster,c.program_id,c.idl_hash,c.protocol_revision,c.event_key)) history ON true
    WHERE ${filter} AND c.commitment='finalized'
      AND ($7::timestamptz IS NULL OR history.block_time>=$7 OR history.block_time IS NULL)
      AND (history.block_time<=$8 OR history.block_time IS NULL)
    ORDER BY o.slot DESC,o.event_key DESC LIMIT $9`;
  // Limit only after canonical/time filtering, separately for each indexed role.
  // The outer merge sorts at most 2*(limit+1) rows, even for very active wallets.
  return {params,text:branches.length===1 ? select(branches[0]) :
    `SELECT * FROM (${branches.map(filter=>`(${select(filter)})`).join(' UNION ALL ')}) candidates
      ORDER BY sort_slot DESC,event_key DESC LIMIT $9`};

}

/** The caller owns a repeatable-read transaction. Exhausting records is not proof of ingestion coverage. */
export async function readEventHistory(client: PoolClient, query: EventHistoryQuery, state?: EventHistoryState) {
  const { pin, identity, window, scope, cursor, supportedEvents } = eventHistorySelection(query);
  const current = state ?? await eventHistoryState(client,identity);
  if (current.conflicted) throw new Error('FINALIZED_INVARIANT: contradictory event-history observations');
  if (cursor && BigInt(cursor.watermark) > BigInt(current.watermark)) invalid();
  const watermark = cursor?.watermark ?? current.watermark;
  const sql = buildEventHistoryQuery(query,watermark);
  const rows = await timedClientQuery<Source>(client,'dusk.history.events.page',sql.text,sql.params);
  for (const row of rows.rows) {
    if (row.stream_count !== '1' || row.matching_count !== '1' || !(row.block_time instanceof Date)
      || !Number.isFinite(row.block_time.getTime()) || BigInt(row.slot) < BigInt(pin.historyFirstSlot))
      throw new Error('FINALIZED_INVARIANT: event-history source or event time is inconsistent');
  }
  const page = rows.rows.slice(0, query.limit), last = page.at(-1);
  const hasMore = rows.rows.length > query.limit;
  const nextCursor = hasMore && last ? Buffer.from(JSON.stringify({ scope, watermark, slot: last.slot, key: last.event_key })).toString('base64url') : null;
  return {
    schemaVersion: query.version === 2 ? 'dusk-event-history.v2' : 'dusk-event-history.v1', window,
    events: page.map(row => ({ eventKey: row.event_key, observationId: row.observation_id,
      eventName: row.event_name, market: row.payload.market, signature: row.signature,
      slot: row.slot, blockhash: row.blockhash, instructionPath: row.instruction_path,
      eventOrdinal: row.event_ordinal, time: row.block_time.toISOString(), payload: row.payload })),
    pagination: { limit: query.limit, cursor: query.cursor ?? null, nextCursor, hasMore, watermark },
    coverage: { cluster: pin.cluster, programId: pin.dusk.programId, idlSha256: pin.dusk.idlCanonicalSha256,
      protocolRevision: pin.revision, deploymentIdentitySha256: query.deploymentIdentitySha256,
      commitment: 'finalized', basis: 'canonical-program-events.v1', historyRangeComplete: false,
      supportedEvents, firstSlot: String(pin.historyFirstSlot) },
  };
}

type EventHistory = Awaited<ReturnType<typeof readEventHistory>>;
const historyCache = new QuoteCache<EventHistory>(128,20_000);
export function clearEventHistoryCache() { historyCache.clear(); }

/** A DB revision is always checked before a hit, even after a missed NOTIFY.
 * Only payloads are cached: the route still verifies deployment before/after.
 * The caller must own a repeatable-read, read-only transaction. */
export async function readCachedEventHistory(client: PoolClient,query: EventHistoryQuery) {
  const selection = eventHistorySelection(query);
  const state = await eventHistoryState(client,selection.identity);
  const key = JSON.stringify([selection.scope,state.revision,state.watermark,query.limit,query.cursor ?? null]);
  const {data,cacheStatus} = await historyCache.getWithMeta(key,
    () => readEventHistory(client,query,state),query.cursor ? 60_000 : 20_000);
  perfMetrics.recordCacheLookup('dusk.history.events',cacheStatus);
  return data;
}

export async function listEventHistory(query: EventHistoryQuery) {
  eventHistorySelection(query);
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const data = await readCachedEventHistory(client,query);
    await client.query('COMMIT');
    return data;
  } catch (error) {
    clearEventHistoryCache();
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}
