import type { Pool, PoolClient } from 'pg';
import pool from '../config/database';
import { loadPinnedProtocol } from '../config/duskProtocol';
import { readStreamCursor } from './duskHistoryCoverage';

export interface JuniorExitPosition {
  market: string;
  juniorMint: string;
  receipts: string;
  readyAt: string;
  expiresAt: string;
  lastSlot: string;
}

/** Burned jrLP remains a live junior claim while it waits. The event fold is
 * generation-scoped and includes request fees, additions, renewals, cancels
 * and completed conversions. */
export async function readJuniorExitPositions(
  owner: string,
  client: Pool | PoolClient = pool,
): Promise<{ positions: JuniorExitPosition[]; sourceSlot: number }> {
  const pin = loadPinnedProtocol();
  const result = await client.query<{
    market: string; junior_mint: string; receipts: string;
    ready_at: string; expires_at: string; last_slot: string;
  }>(
    `SELECT market,junior_mint,receipts::text,ready_at::text,expires_at::text,last_slot::text
       FROM dusk_ingestion.streamed_junior_exits
      WHERE cluster=$1 AND program_id=$2 AND idl_hash=$3 AND protocol_revision=$4
        AND owner=$5 AND receipts>0
      ORDER BY market,junior_mint`,
    [pin.cluster,pin.dusk.programId,pin.dusk.idlCanonicalSha256,pin.revision,owner],
  );
  const stream = await readStreamCursor(client);
  if (!stream) throw Object.assign(new Error('The Dusk stream has not started'), { status: 503 });
  return {
    positions: result.rows.map((row) => ({
      market: row.market,
      juniorMint: row.junior_mint,
      receipts: row.receipts,
      readyAt: row.ready_at,
      expiresAt: row.expires_at,
      lastSlot: row.last_slot,
    })),
    sourceSlot: Number(stream.throughSlot),
  };
}
