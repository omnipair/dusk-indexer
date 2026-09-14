import { PoolClient } from 'pg';
import { PublicKey } from '@solana/web3.js';
import pool from '../config/database';
import { loadPinnedProtocol, sha256, canonicalJson } from '../config/duskProtocol';
import { HistoryDeploymentQuery, historyDeploymentIdentities } from './duskHistoryDeployment';
import { StoredYieldCheckpointObservation, verifyYieldCheckpointObservation } from './duskYieldCheckpoints';
import { assertNoPriceConflict, StoredPriceCapture, verifyStoredPriceCapture } from './duskPrices';
import { MarketGrowthPoint, marketGrowthPoint, recordedYlpRates } from './duskYieldRateMath';

export interface YieldRatesQuery extends HistoryDeploymentQuery { since: string; until: string; market?: string }
const MAX_SNAPSHOT_AGE_SECONDS = 900;
const MAX_PRICE_AGE_SECONDS = 3600;

/** Recorded claimable yLP earnings only. Compounding, unpaid debt interest and
 * protocol revenue remain separate; these rates are never a full APY. */
export async function readYieldRates(client: PoolClient,options: YieldRatesQuery) {
  const pin = loadPinnedProtocol(),active = [pin.cluster,pin.dusk.programId,pin.dusk.idlCanonicalSha256,pin.revision];
  const since = Date.parse(options.since),until = Date.parse(options.until);
  if (!/^[0-9a-f]{64}$/.test(options.deploymentIdentitySha256) || !Number.isFinite(since) || !Number.isFinite(until)
    || until-since<3600_000 || until-since>90*86400_000 || until>Date.now()
    || options.market !== undefined && new PublicKey(options.market).toBase58() !== options.market)
    throw Object.assign(new Error('Invalid recorded yield window'),{ status: 400 });
  const deployments = await historyDeploymentIdentities(client,options);
  // A contradictory market read is a halt even if it came from two different
  // owners' yield checkpoints, or the worker has not projected it yet.
  const conflicts = await client.query(`SELECT 1 FROM dusk_ingestion.yield_checkpoint_observations
    WHERE cluster=$1 AND program_id=$2 AND idl_hash=$3 AND protocol_revision=$4
    GROUP BY market,slot HAVING count(DISTINCT (blockhash,block_time,source_accounts->'market'))>1 LIMIT 1`,active);
  if (conflicts.rowCount) throw new Error('FINALIZED_INVARIANT: contradictory committed market growth');
  await assertNoPriceConflict(client);
  const sources = await client.query<StoredYieldCheckpointObservation & { observation_id: string; boundary: string }>(`
    WITH markets AS (
      SELECT DISTINCT market FROM dusk_ingestion.yield_checkpoints
      WHERE cluster=$1 AND program_id=$2 AND idl_hash=$3 AND protocol_revision=$4
        AND ($7::text IS NULL OR market=$7)
    ), boundaries(boundary,at) AS (VALUES ('start',$5::timestamptz),('end',$6::timestamptz))
    SELECT o.*,o.slot::text,o.observation_id::text,b.boundary
    FROM markets m CROSS JOIN boundaries b
    JOIN LATERAL (
      SELECT o.* FROM dusk_ingestion.yield_checkpoint_observations o
      JOIN dusk_ingestion.yield_checkpoints p USING(observation_id)
      WHERE o.cluster=$1 AND o.program_id=$2 AND o.idl_hash=$3 AND o.protocol_revision=$4
        AND o.market=m.market AND o.block_time<=b.at
        AND o.block_time>=b.at-($8::int*interval '1 second')
        AND o.deployment_identity_sha256=ANY($9::text[])
      ORDER BY o.slot DESC,o.observation_id DESC LIMIT 1
    ) o ON true ORDER BY m.market,b.boundary`,
    [...active,new Date(since).toISOString(),new Date(until).toISOString(),options.market ?? null,MAX_SNAPSHOT_AGE_SECONDS,deployments]);
  const byMarket = new Map<string,Partial<Record<'start'|'end',{ point: MarketGrowthPoint; contentHash: string }>>>();
  for (const row of sources.rows) {
    if (!deployments.includes(row.deployment_identity_sha256) || row.boundary !== 'start' && row.boundary !== 'end')
      throw new Error('FINALIZED_INVARIANT: invalid yield growth selection');
    const { source,marketState } = verifyYieldCheckpointObservation(row);
    const point = marketGrowthPoint({ pin,marketAddress: source.market,market: marketState,slot: source.slot,
      blockTime: source.blockTime,deploymentIdentitySha256: source.deploymentIdentitySha256 });
    const market = byMarket.get(point.market) ?? {};
    if (market[row.boundary]) throw new Error('FINALIZED_INVARIANT: duplicate yield growth boundary');
    market[row.boundary] = { point,contentHash: row.content_hash };
    byMarket.set(point.market,market);
  }
  const priceAt = async (point: MarketGrowthPoint) => {
    const rows = await client.query<StoredPriceCapture>(`SELECT *,slot::text,market_slot::text,capture_id::text
      FROM dusk_ingestion.price_capture_observations p
      WHERE cluster=$1 AND program_id=$2 AND idl_hash=$3 AND protocol_revision=$4 AND market=$5
        AND deployment_identity_sha256=ANY($6::text[]) AND slot<$7 AND block_time<=$8
        AND block_time>=$8::timestamptz-($9::int*interval '1 second')
      ORDER BY p.slot DESC,p.capture_id DESC LIMIT 1`,
      [...active,point.market,deployments,point.slot,point.blockTime,MAX_PRICE_AGE_SECONDS]);
    const row = rows.rows[0];
    if (!row) return { prices: [],provenance: null };
    const { source,projected } = verifyStoredPriceCapture(row);
    if (source.market !== point.market || source.slot>=point.slot || !deployments.includes(source.deploymentIdentitySha256)
      || Date.parse(source.blockTime)>Date.parse(point.blockTime)
      || Date.parse(point.blockTime)-Date.parse(source.blockTime)>MAX_PRICE_AGE_SECONDS*1000)
      throw new Error('FINALIZED_INVARIANT: recorded yield price exceeds its boundary');
    return { prices: projected.prices,provenance: { sourceSlot: String(source.slot),blockTime: source.blockTime,
      deploymentIdentitySha256: source.deploymentIdentitySha256,contentHash: row.content_hash,referenceHash: projected.referenceHash } };
  };
  const markets = [];
  for (const [market,{start,end}] of byMarket) {
    if (!start || !end) continue; // Missing brackets remain explicitly unmeasured.
    const initialPrice = await priceAt(start.point),finalPrice = await priceAt(end.point);
    const rates = recordedYlpRates({start:start.point,end:end.point,startPrices:initialPrice.prices,endPrices:finalPrice.prices});
    markets.push({ market,lpMint: start.point.lpMint,rates,
      window: { since: start.point.blockTime,until: end.point.blockTime },
      provenance: { startSlot: String(start.point.slot),endSlot: String(end.point.slot),
        startContentHash: start.contentHash,endContentHash: end.contentHash,
        startDeploymentIdentitySha256: start.point.deploymentIdentitySha256,endDeploymentIdentitySha256: end.point.deploymentIdentitySha256,
        initialPrice: initialPrice.provenance,finalPrice: finalPrice.provenance } });
  }
  const window = { since: new Date(since).toISOString(),until: new Date(until).toISOString(),
    maxSnapshotAgeSeconds: MAX_SNAPSHOT_AGE_SECONDS,maxPriceAgeSeconds: MAX_PRICE_AGE_SECONDS };
  return { schemaVersion: 'dusk-yield-rates.v1' as const,window,markets,
    coverage: { cluster: pin.cluster,programId: pin.dusk.programId,idlSha256: pin.dusk.idlCanonicalSha256,
      protocolRevision: pin.revision,deploymentIdentitySha256: options.deploymentIdentitySha256,commitment: 'finalized' as const,
      basis: 'committed-market-growth.v1' as const,fullApyAvailable: false as const,
      sourceSlot: Math.max(0,...sources.rows.map(row => Number(row.slot))),
      selectionHash: sha256(canonicalJson([active,options.deploymentIdentitySha256,window,markets])) } };
}

export async function listYieldRates(options: YieldRatesQuery) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const result = await readYieldRates(client,options);
    await client.query('COMMIT');
    return result;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
