import { PoolClient } from 'pg';
import { PublicKey } from '@solana/web3.js';
import pool from '../config/database';
import { loadPinnedProtocol, sha256, canonicalJson } from '../config/duskProtocol';
import { HistoryDeploymentQuery } from './duskHistoryDeployment';
import { activePriceReferences, projectObservedPrices } from './duskPriceMath';
import { MarketGrowthPoint, observedGrowthPoint, recordedYlpRates } from './duskYieldRateMath';

export interface YieldRatesQuery extends HistoryDeploymentQuery { since: string; until: string; market?: string }
const MAX_SNAPSHOT_AGE_SECONDS = 900;
const MAX_PRICE_AGE_SECONDS = 3600;
interface Observation { market: string; slot: string; time: Date; payload: unknown; payload_hash: string }

/** Recorded claimable yLP earnings only. Compounding, unpaid debt interest and
 * protocol revenue remain separate; these rates are never a full APY. Growth
 * points and their prices come from MarketObserved events, which the
 * permissionless crank emits after refreshing each market. */
export async function readYieldRates(client: PoolClient,options: YieldRatesQuery) {
  const pin = loadPinnedProtocol(),active = [pin.cluster,pin.dusk.programId,pin.dusk.idlCanonicalSha256,pin.revision];
  const since = Date.parse(options.since),until = Date.parse(options.until);
  if (!/^[0-9a-f]{64}$/.test(options.deploymentIdentitySha256) || !Number.isFinite(since) || !Number.isFinite(until)
    || until-since<3600_000 || until-since>90*86400_000 || until>Date.now()
    || options.market !== undefined && new PublicKey(options.market).toBase58() !== options.market)
    throw Object.assign(new Error('Invalid recorded yield window'),{ status: 400 });
  const sources = await client.query<Observation & { boundary: 'start' | 'end' }>(`
    WITH markets AS (
      SELECT DISTINCT market FROM dusk_ingestion.streamed_market_observations
      WHERE cluster=$1 AND program_id=$2 AND idl_hash=$3 AND protocol_revision=$4 AND ($7::text IS NULL OR market=$7)
    ), boundaries(boundary,at) AS (VALUES ('start',$5::timestamptz),('end',$6::timestamptz))
    SELECT m.market,o.slot::text,o.time,o.payload,o.payload_hash,b.boundary
    FROM markets m CROSS JOIN boundaries b
    JOIN LATERAL (
      SELECT slot,time,payload,payload_hash,observation_id FROM dusk_ingestion.streamed_events
      WHERE cluster=$1 AND program_id=$2 AND idl_hash=$3 AND protocol_revision=$4 AND event_name='MarketObserved'
        AND payload->>'market'=m.market AND time<=b.at AND time>=b.at-($8::int*interval '1 second')
      ORDER BY slot DESC,observation_id DESC LIMIT 1
    ) o ON true ORDER BY m.market,b.boundary`,
    [...active,new Date(since).toISOString(),new Date(until).toISOString(),options.market ?? null,MAX_SNAPSHOT_AGE_SECONDS]);
  const byMarket = new Map<string,Partial<Record<'start'|'end',{ point: MarketGrowthPoint; contentHash: string }>>>();
  for (const row of sources.rows) {
    const point = observedGrowthPoint({ pin,marketAddress: row.market,observation: row.payload,slot: Number(row.slot),
      blockTime: row.time.toISOString(),deploymentIdentitySha256: options.deploymentIdentitySha256 });
    const market = byMarket.get(point.market) ?? {};
    if (market[row.boundary]) throw new Error('FINALIZED_INVARIANT: duplicate yield growth boundary');
    market[row.boundary] = { point,contentHash: row.payload_hash };
    byMarket.set(point.market,market);
  }
  const references = activePriceReferences();
  // The latest observation at or before the point, within the price age bound.
  const priceAt = async (point: MarketGrowthPoint) => {
    const rows = await client.query<Observation>(`SELECT payload->>'market' AS market,slot::text,time,payload,payload_hash
      FROM dusk_ingestion.streamed_events
      WHERE cluster=$1 AND program_id=$2 AND idl_hash=$3 AND protocol_revision=$4 AND event_name='MarketObserved'
        AND payload->>'market'=$5 AND slot<=$6 AND time<=$7 AND time>=$7::timestamptz-($8::int*interval '1 second')
      ORDER BY slot DESC,observation_id DESC LIMIT 1`,[...active,point.market,point.slot,point.blockTime,MAX_PRICE_AGE_SECONDS]);
    const row = rows.rows[0];
    if (!row) return { prices: [],provenance: null };
    const projected = projectObservedPrices({ pin,observation: row.payload,blockTime: row.time.toISOString(),references });
    return { prices: projected.prices,provenance: { sourceSlot: row.slot,blockTime: row.time.toISOString(),
      deploymentIdentitySha256: options.deploymentIdentitySha256,contentHash: row.payload_hash,referenceHash: projected.referenceHash } };
  };
  const markets = [];
  for (const [market,{start,end}] of byMarket) {
    if (!start || !end || start.point.slot>=end.point.slot) continue; // Missing brackets remain explicitly unmeasured.
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
      protocolRevision: pin.revision,deploymentIdentitySha256: options.deploymentIdentitySha256,commitment: 'confirmed' as const,
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
