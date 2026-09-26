import { PoolClient } from 'pg';
import { loadPinnedProtocol } from '../config/duskProtocol';

/** The daemon's stream, `persist::STREAM_NAME`. */
export const DUSK_STREAM_NAME = 'helius-atlas-ws';

export interface StreamCursor {
  /** At least every slot the stream has written. */
  throughSlot: string;
  /** Every transaction that arrived before this is written. */
  time: Date;
  /** When this database registered the release: ingestion began here. */
  startedAt: Date;
}

/** The stream's cursor. Its time advances only after a transaction's writes or
 * on a heartbeat while the WebSocket delivers verified Clock updates. As in the
 * v1 indexer there is no backfill: a reconnect can drop transactions, which
 * `--replay` re-ingests.
 */
export async function readStreamCursor(client: PoolClient): Promise<StreamCursor | null> {
  const pin = loadPinnedProtocol();
  const result = await client.query<{ through_slot: string | null; updated_at: Date; registered_at: Date }>(
    `SELECT c.last_observed_slot::text AS through_slot,c.updated_at,d.registered_at
    FROM dusk_ingestion.ingestion_cursors c JOIN dusk_ingestion.deployment_intervals d USING(cluster,protocol_revision)
    WHERE c.cluster=$1 AND c.program_id=$2 AND c.idl_hash=$3 AND c.protocol_revision=$4 AND c.stream_name=$5`,
    [pin.cluster,pin.dusk.programId,pin.dusk.idlCanonicalSha256,pin.revision,DUSK_STREAM_NAME]);
  const row = result.rows[0];
  if (!row) return null;
  // The daemon's clock is not this host's. A claim later than now is only
  // skew, and a narrower claim stays true.
  const time = Math.min(row.updated_at.getTime(),Date.now());
  return { throughSlot: row.through_slot ?? String(pin.historyFirstSlot),time: new Date(time),
    startedAt: new Date(Math.min(row.registered_at.getTime(),time)) };
}

export interface HistoryScan {
  basis: 'confirmed-stream.v1';
  firstSlot: string;
  throughSlot: string;
  /** For the stream basis, `StreamCursor.startedAt`. */
  releaseBlockTime: string;
  throughBlockTime: string;
  completedAt: string;
}

/** Activity coverage is the stream's cursor, from the release's registration
 * to the cursor's time.
 */
export async function readHistoryScan(client: PoolClient): Promise<HistoryScan | null> {
  const cursor = await readStreamCursor(client);
  if (!cursor) return null;
  return { basis: 'confirmed-stream.v1',firstSlot: String(loadPinnedProtocol().historyFirstSlot),throughSlot: cursor.throughSlot,
    releaseBlockTime: cursor.startedAt.toISOString(),throughBlockTime: cursor.time.toISOString(),completedAt: cursor.time.toISOString() };
}

/** Whole wall-clock ranges must lie strictly inside the covered interval.
 * Open-ended/all-time requests may predate this IDL and are never complete.
 * The upper millisecond is excluded because a later arrival may share it.
 */
export function historyScanCovers(scan: HistoryScan | null,since: string | undefined,until: string): boolean {
  return Boolean(scan && since && Date.parse(since)>Date.parse(scan.releaseBlockTime)
    && Date.parse(until)<Date.parse(scan.throughBlockTime));
}
