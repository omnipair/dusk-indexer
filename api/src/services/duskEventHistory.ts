import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { PoolClient } from 'pg';
import pool from '../config/database';
import { loadPinnedProtocol } from '../config/duskProtocol';

export const HISTORY_EVENTS = [
  'SwapExecuted', 'LiquidityAdded', 'LiquidityRemoved',
  'MarketCollateralDeposited', 'MarketCollateralWithdrawn', 'MarketDebtUpdated',
  'BorrowPositionLiquidated', 'LeveragePositionOpened', 'LeveragePositionUpdated',
  'LeveragePositionClosed', 'LeveragePositionLiquidated',
] as const;

export interface EventHistoryQuery {
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
  if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 500
    || !/^[0-9a-f]{64}$/.test(query.deploymentIdentitySha256)
    || !Number.isFinite(Date.parse(query.until)) || Date.parse(query.until) > Date.now()
    || query.since !== undefined && (!Number.isFinite(Date.parse(query.since)) || Date.parse(query.since) > Date.parse(query.until))) invalid();
  if (query.market !== undefined) {
    try { if (new PublicKey(query.market).toBase58() !== query.market) invalid(); } catch { invalid(); }
  }
  const identity = [pin.cluster, pin.dusk.programId, pin.dusk.idlCanonicalSha256, pin.revision];
  const window = { market: query.market ?? null, since: query.since ? new Date(query.since).toISOString() : null, until: new Date(query.until).toISOString() };
  const scope = createHash('sha256').update(JSON.stringify([identity, query.deploymentIdentitySha256, window, HISTORY_EVENTS])).digest('hex');
  let cursor: Cursor | null = null;
  if (query.cursor !== undefined) {
    try {
      if (query.cursor.length > 2048 || !/^[\w-]+$/.test(query.cursor)) invalid();
      cursor = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8'));
      if (!cursor || cursor.scope !== scope || !integer(cursor.watermark) || !integer(cursor.slot)
        || BigInt(cursor.slot) < BigInt(pin.historyFirstSlot) || !canonicalCursorKey(cursor.key, identity)) invalid();
    } catch { invalid(); }
  }
  return { pin, identity, window, scope, cursor };
}

type Source = {
  event_key: string; observation_id: string; event_name: string; signature: string;
  slot: string; blockhash: string; instruction_path: number[]; event_ordinal: number;
  payload: Record<string, unknown>; block_time: Date; stream_count: string; matching_count: string;
};

/** The caller owns a repeatable-read transaction. Exhausting records is not proof of ingestion coverage. */
export async function readEventHistory(client: PoolClient, query: EventHistoryQuery) {
  const { pin, identity, window, scope, cursor } = eventHistorySelection(query);
  const watermarkRead = await client.query<{ watermark: string }>(`SELECT COALESCE(max(observation_id),0)::text AS watermark
    FROM dusk_ingestion.event_observations WHERE cluster=$1 AND program_id=$2 AND idl_hash=$3 AND protocol_revision=$4`, identity);
  const latestWatermark = watermarkRead.rows[0].watermark;
  if (cursor && BigInt(cursor.watermark) > BigInt(latestWatermark)) invalid();
  const watermark = cursor?.watermark ?? latestWatermark;
  // A finalized contradiction is a halt, even when the contradictory row is
  // outside the requested page. Never pick a winner from arrival order.
  const conflict = await client.query(`SELECT 1 FROM dusk_ingestion.event_observations
    WHERE cluster=$1 AND program_id=$2 AND idl_hash=$3 AND protocol_revision=$4 AND commitment='finalized'
    GROUP BY event_key HAVING count(DISTINCT (blockhash,slot,payload_hash,event_name))>1 LIMIT 1`, identity);
  if (conflict.rowCount) throw new Error('FINALIZED_INVARIANT: contradictory event-history observations');
  const rows = await client.query<Source>(`SELECT c.event_key,o.observation_id::text,o.event_name,
      o.transaction_signature AS signature,o.slot::text,o.blockhash,o.instruction_path,o.event_ordinal,
      o.decoded_payload AS payload,history.block_time,history.stream_count,history.matching_count
    FROM dusk_ingestion.canonical_events c
    JOIN dusk_ingestion.event_observations o USING(cluster,program_id,idl_hash,protocol_revision,event_key,observation_id)
    LEFT JOIN LATERAL (SELECT min(s.time) AS block_time,count(*)::text AS stream_count,
      count(*) FILTER(WHERE s.event_name=o.event_name AND s.slot=o.slot AND s.transaction_signature=o.transaction_signature
        AND s.market=o.decoded_payload->>'market' AND s.payload=o.decoded_payload)::text AS matching_count
      FROM dusk_ingestion.event_stream s WHERE
        (s.cluster,s.program_id,s.idl_hash,s.protocol_revision,s.event_key)=(c.cluster,c.program_id,c.idl_hash,c.protocol_revision,c.event_key)) history ON true
    WHERE c.cluster=$1 AND c.program_id=$2 AND c.idl_hash=$3 AND c.protocol_revision=$4
      AND c.commitment='finalized' AND o.commitment='finalized' AND o.observation_id<=$5::bigint
      AND o.event_name=ANY($6::text[]) AND ($7::text IS NULL OR o.decoded_payload->>'market'=$7)
      AND ($8::timestamptz IS NULL OR history.block_time>=$8 OR history.block_time IS NULL)
      AND (history.block_time<=$9 OR history.block_time IS NULL)
      AND ($10::bigint IS NULL OR (o.slot,c.event_key)<($10::bigint,$11::text))
    ORDER BY o.slot DESC,c.event_key DESC LIMIT $12`,
    [...identity, watermark, HISTORY_EVENTS, window.market, window.since, window.until, cursor?.slot ?? null, cursor?.key ?? null, query.limit + 1]);
  for (const row of rows.rows) {
    if (row.stream_count !== '1' || row.matching_count !== '1' || !(row.block_time instanceof Date)
      || !Number.isFinite(row.block_time.getTime()) || BigInt(row.slot) < BigInt(pin.historyFirstSlot))
      throw new Error('FINALIZED_INVARIANT: event-history source or event time is inconsistent');
  }
  const page = rows.rows.slice(0, query.limit), last = page.at(-1);
  const hasMore = rows.rows.length > query.limit;
  const nextCursor = hasMore && last ? Buffer.from(JSON.stringify({ scope, watermark, slot: last.slot, key: last.event_key })).toString('base64url') : null;
  return {
    schemaVersion: 'dusk-event-history.v1', window,
    events: page.map(row => ({ eventKey: row.event_key, observationId: row.observation_id,
      eventName: row.event_name, market: row.payload.market, signature: row.signature,
      slot: row.slot, blockhash: row.blockhash, instructionPath: row.instruction_path,
      eventOrdinal: row.event_ordinal, time: row.block_time.toISOString(), payload: row.payload })),
    pagination: { limit: query.limit, cursor: query.cursor ?? null, nextCursor, hasMore, watermark },
    coverage: { cluster: pin.cluster, programId: pin.dusk.programId, idlSha256: pin.dusk.idlCanonicalSha256,
      protocolRevision: pin.revision, deploymentIdentitySha256: query.deploymentIdentitySha256,
      commitment: 'finalized', basis: 'canonical-program-events.v1', historyRangeComplete: false,
      supportedEvents: HISTORY_EVENTS, firstSlot: String(pin.historyFirstSlot) },
  };
}

export async function listEventHistory(query: EventHistoryQuery) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const data = await readEventHistory(client, query);
    await client.query('COMMIT');
    return data;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
