import type { Pool, PoolClient } from 'pg';
import pool from '../config/database';
import { loadPinnedProtocol } from '../config/duskProtocol';
import type { DuskDeploymentEnvelope } from './duskDeploymentService';
import { readStreamCursor } from './duskHistoryCoverage';
import { listMarketActivity } from './duskMarketActivity';

/** Open interest from streamed leverage positions: collateral of every open
 * position per market and side. The stream's slot, read after the positions,
 * covers every event they include. */
export async function readMarketExposures(client: Pool | PoolClient = pool) {
  const pin = loadPinnedProtocol();
  const result = await client.query<{ market: string; base_collateral: string; quote_collateral: string; positions: number }>(`
    SELECT p.market,
      COALESCE(sum(p.collateral_amount) FILTER (WHERE p.collateral_asset_mint=m.base_mint),0)::text AS base_collateral,
      COALESCE(sum(p.collateral_amount) FILTER (WHERE p.collateral_asset_mint=m.quote_mint),0)::text AS quote_collateral,
      count(*)::int AS positions
    FROM dusk_ingestion.streamed_leverage_positions p
    JOIN dusk_ingestion.streamed_markets m USING(cluster,program_id,idl_hash,protocol_revision,market)
    WHERE p.cluster=$1 AND p.program_id=$2 AND p.idl_hash=$3 AND p.protocol_revision=$4 AND p.open AND p.collateral_amount>0
    GROUP BY p.market ORDER BY p.market`,[pin.cluster,pin.dusk.programId,pin.dusk.idlCanonicalSha256,pin.revision]);
  const stream = await readStreamCursor(client);
  if (!stream) throw Object.assign(new Error('The Dusk stream has not started'),{ status: 503 });
  return { sourceSlot: Number(stream.throughSlot),observedAt: Date.now(),complete: true,
    markets: result.rows.map((row) => ({ market: row.market,baseCollateral: row.base_collateral,
      quoteCollateral: row.quote_collateral,positions: row.positions })) };
}
export async function captureStatisticsSnapshot(
  range: '24h' | 'all',
  deployment: DuskDeploymentEnvelope,
  signal?: AbortSignal,
) {
  const now = Date.now(),
    until = new Date(now).toISOString();
  let request = {
    ...(range === '24h'
      ? { since: new Date(now - 86_400_000).toISOString() }
      : {}),
    until,
  };
  const [initial, exposures] = await Promise.all([
    listMarketActivity({
      ...request,
      deployment,
      deploymentIdentitySha256: deployment.deploymentIdentitySha256,
    }),
    readMarketExposures(),
  ]);
  let activity = initial;
  const scan = initial.coverage.historyScan;
  if (range === '24h' && scan) {
    const through = Date.parse(scan.throughBlockTime),
      end = through - 1,
      start = end - 86_400_000;
    if (
      through <= now &&
      now - through < 120_000 &&
      start > Date.parse(scan.releaseBlockTime)
    ) {
      request = {
        since: new Date(start).toISOString(),
        until: new Date(end).toISOString(),
      };
      activity = await listMarketActivity({
        ...request,
        deployment,
        deploymentIdentitySha256: deployment.deploymentIdentitySha256,
      });
    }
  }
  signal?.throwIfAborted();
  return {
    schemaVersion: 'dusk-statistics.v1',
    range,
    request,
    activity,
    exposures,
    sourceSlot: Math.max(
      exposures.sourceSlot,
      Number(activity.coverage.lastSourceSlot ?? 0),
      Number(activity.coverage.historyScan?.throughSlot ?? 0),
    ),
  };
}
