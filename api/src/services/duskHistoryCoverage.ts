import { PoolClient } from 'pg';
import { loadPinnedProtocol } from '../config/duskProtocol';

export interface HistoryScan {
  basis: 'finalized-address-scan.v1';
  firstSlot: string;
  throughSlot: string;
  releaseBlockTime: string;
  throughBlockTime: string;
  completedAt: string;
}

/** Slot coverage is a decoded scan, not the attestation/cursor heartbeat. */
export async function readHistoryScan(client: PoolClient): Promise<HistoryScan | null> {
  const pin = loadPinnedProtocol();
  const result = await client.query<{
    through_slot: string; release_block_time: Date; through_block_time: Date; completed_at: Date;
  }>(`SELECT through_slot::text,release_block_time,through_block_time,completed_at
    FROM dusk_ingestion.history_scans WHERE cluster=$1 AND program_id=$2 AND idl_hash=$3 AND protocol_revision=$4
    ORDER BY through_slot DESC LIMIT 1`,[pin.cluster,pin.dusk.programId,pin.dusk.idlCanonicalSha256,pin.revision]);
  const row = result.rows[0];
  if (!row) return null;
  return { basis: 'finalized-address-scan.v1',firstSlot: String(pin.historyFirstSlot),throughSlot: row.through_slot,
    releaseBlockTime: row.release_block_time.toISOString(),throughBlockTime: row.through_block_time.toISOString(),
    completedAt: row.completed_at.toISOString() };
}

/** Whole wall-clock ranges must lie strictly inside the scanned release.
 * Open-ended/all-time requests may predate this IDL and are never complete.
 * The upper second is excluded because later slots may share its block time.
 */
export function historyScanCovers(scan: HistoryScan | null,since: string | undefined,until: string): boolean {
  return Boolean(scan && since && Date.parse(since)>Date.parse(scan.releaseBlockTime)
    && Date.parse(until)<Date.parse(scan.throughBlockTime));
}
