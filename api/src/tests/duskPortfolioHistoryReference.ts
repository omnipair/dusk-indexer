/** Independent pre-optimization SQL oracle for complete response equivalence. */
import type { PoolClient } from 'pg';
import { PublicKey } from '@solana/web3.js';
import { loadPinnedProtocol } from '../config/duskProtocol';
import { assertNoPortfolioConflict,portfolioSampleSeconds,type PortfolioHistoryQuery } from '../services/duskPortfolioSnapshots';
const identity = () => { const pin = loadPinnedProtocol();return [pin.cluster,pin.dusk.programId,pin.dusk.idlCanonicalSha256,pin.revision]; };
const nativeKey = (value: string) => new PublicKey(value).toBase58();

export async function referencePortfolioHistory(client: PoolClient,options: PortfolioHistoryQuery) {
  const active = identity(),values: unknown[] = [...active,nativeKey(options.owner)];
  const filters = ['cluster=$1','program_id=$2','idl_hash=$3','protocol_revision=$4','owner=$5'];
  for (const [name,operator] of [['since','>='],['until','<=']] as const) if (options[name]) {
    const time = new Date(options[name]!).toISOString(); values.push(time); filters.push(`bucket${operator}$${values.length}`);
  }
  await assertNoPortfolioConflict(client);
  const seconds = portfolioSampleSeconds(options.sampleSeconds);
  const filtered = `filtered AS (SELECT * FROM dusk_ingestion.portfolio_effective_checkpoints WHERE ${filters.join(' AND ')})`;
  // Keep both sides of each availability transition before downsampling.
  // Otherwise an unavailable interval inside one display bucket disappears.
  const selection = seconds === 0 ? `${filtered},selected AS (SELECT * FROM filtered)` : `${filtered},
    bucket_latest AS (SELECT DISTINCT ON (floor(extract(epoch FROM bucket)/$${values.length+1})) capture_id
      FROM filtered ORDER BY floor(extract(epoch FROM bucket)/$${values.length+1}),bucket DESC,source_max_slot DESC,capture_id DESC),
    availability AS (SELECT capture_id,(valuations->>'unvaluedComponents')::int>0 AS missing,
      lag((valuations->>'unvaluedComponents')::int>0) OVER chronology AS previous_missing,
      lead((valuations->>'unvaluedComponents')::int>0) OVER chronology AS next_missing
      FROM filtered WINDOW chronology AS (ORDER BY bucket,source_max_slot,capture_id)),
    boundaries AS (SELECT capture_id FROM availability
      WHERE missing IS DISTINCT FROM previous_missing OR missing IS DISTINCT FROM next_missing),
    selected AS (SELECT * FROM filtered WHERE capture_id IN
      (SELECT capture_id FROM bucket_latest UNION SELECT capture_id FROM boundaries))`;
  if (seconds !== 0) values.push(seconds);
  const summary = await client.query(`WITH ${selection} SELECT count(*)::text AS total,min(bucket) AS first_time,max(bucket) AS last_time,
    max(source_max_slot)::text AS last_slot,
    encode(sha256(convert_to(coalesce(string_agg(capture_id::text||':'||valuation_revision,',' ORDER BY capture_id),''),'UTF8')),'hex') AS selection_hash,
    (SELECT count(*)::text FROM filtered) AS raw_total,
    (SELECT count(*)::text FROM filtered WHERE valuation_revision<>'original') AS repaired_snapshots,
    (SELECT count(*)::text FROM filtered WHERE valuations->>'quality' NOT IN ('reference-valued','empty')
      OR valuations->>'netPositionValueUsd' IS NULL OR (valuations->>'unvaluedComponents')::int>0) AS unvalued_snapshots
    FROM selected`,values);
  const rows = await client.query(`WITH ${selection} SELECT capture_id::text,owner,bucket,observed_at,source_min_slot::text,source_max_slot::text,components,coverage,valuations
    FROM selected ORDER BY bucket DESC,source_max_slot DESC,capture_id DESC
    LIMIT $${values.length+1} OFFSET $${values.length+2}`,[...values,options.limit,options.offset]);
  const pending = await client.query(`SELECT count(*)::text AS count FROM dusk_ingestion.portfolio_capture_observations o
    WHERE cluster=$1 AND program_id=$2 AND idl_hash=$3 AND protocol_revision=$4
      AND NOT EXISTS(SELECT 1 FROM dusk_ingestion.portfolio_capture_projections p WHERE p.capture_id=o.capture_id)`,active);
  const provenance = { cluster: active[0],programId: active[1],idlSha256: active[2],protocolRevision: active[3],commitment: 'finalized' as const };
  return { snapshots: rows.rows.map((row) => ({ captureId: row.capture_id,owner: row.owner,capturedAt: row.bucket.toISOString(),
    components: row.components,valuations: row.valuations,coverage: row.coverage,provenance: { ...provenance,
      sourceMinSlot: row.source_min_slot,sourceMaxSlot: row.source_max_slot,observedAt: row.observed_at.toISOString(),
      deploymentIdentitySha256: row.coverage.deploymentIdentitySha256 } })),
    pagination: { limit: options.limit,offset: options.offset,total: Number(summary.rows[0].total) },
    coverage: { available: rows.rows.length>0,historyComplete: false,atomicAcrossMarkets: false,basis: 'sampled-native-positions.v1',
      sampleSeconds: seconds,selectionHash: summary.rows[0].selection_hash as string,gapBoundariesRetained: true,
      rawTotal: Number(summary.rows[0].raw_total),unvaluedSnapshots: Number(summary.rows[0].unvalued_snapshots),
      repairedSnapshots: Number(summary.rows[0].repaired_snapshots),
      firstSnapshotAt: summary.rows[0].first_time?.toISOString() ?? null,lastSnapshotAt: summary.rows[0].last_time?.toISOString() ?? null,
      lastSourceSlot: summary.rows[0].last_slot as string | null,pendingCaptures: pending.rows[0].count as string } };
}
