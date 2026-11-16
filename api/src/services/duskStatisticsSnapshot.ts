import type { Pool, PoolClient } from 'pg';
import pool from '../config/database';
import { loadPinnedProtocol } from '../config/duskProtocol';
import type { DuskDeploymentEnvelope } from './duskDeploymentService';
import { readHistoryScan, readStreamCursor } from './duskHistoryCoverage';
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
export const statisticsDependencies = {
  now: () => Date.now(),
  historyScan: () => readHistoryScan(pool),
  activity: listMarketActivity,
  exposures: readMarketExposures,
};

export async function captureStatisticsSnapshot(
  range: '24h' | 'all',
  deployment: DuskDeploymentEnvelope,
  signal?: AbortSignal,
  dependencies = statisticsDependencies,
) {
  signal?.throwIfAborted();
  const now = dependencies.now(),
    until = new Date(now).toISOString();
  let request = {
    ...(range === '24h'
      ? { since: new Date(now - 86_400_000).toISOString() }
      : {}),
    until,
  };
  // Choose a covered window from the cheap cursor read before valuing events.
  // Previously the entire window was valued once just to obtain this cursor,
  // then valued again at the adjusted end time, exhausting the stream deadline.
  const scan = range === '24h' ? await dependencies.historyScan() : null;
  if (range === '24h' && scan) {
    const through = Date.parse(scan.throughBlockTime),
      end = through - 1,
      start = end - 86_400_000;
    if (
      through <= now &&
      now - through < 120_000
    ) {
      request = {
        since: new Date(start).toISOString(),
        until: new Date(end).toISOString(),
      };
    }
  }
  signal?.throwIfAborted();
  const [activity, exposures] = await Promise.all([
    dependencies.activity({
      ...request,
      deployment,
      deploymentIdentitySha256: deployment.deploymentIdentitySha256,
    }),
    dependencies.exposures(),
  ]);
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
