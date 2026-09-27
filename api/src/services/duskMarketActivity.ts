import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { PoolClient } from 'pg';
import { PublicKey } from '@solana/web3.js';
import pool from '../config/database';
import { loadPinnedProtocol } from '../config/duskProtocol';
import { ACTIVITY_EVENTS, ACTIVITY_METRICS, ActivityMetric, ActivityPriceBasis, ActivityExternalPrice, activityPriceBasis, parseActivityEvent, swapVolumeBasis, valueActivityAmounts } from './duskActivityMath';
import { formatUsd, usdUnits } from './duskPortfolioMath';
import { activePriceReferences, projectObservedPrices } from './duskPriceMath';
import { HistoryDeploymentQuery, historyDeploymentIdentities } from './duskHistoryDeployment';
import { historyScanCovers, readHistoryScan } from './duskHistoryCoverage';

const identity = () => {
  const pin = loadPinnedProtocol();
  return [pin.cluster,pin.dusk.programId,pin.dusk.idlCanonicalSha256,pin.revision];
};
function activeSwapBasis() {
  loadPinnedProtocol(); // Verifies the IDL hash before choosing its event contract.
  return swapVolumeBasis(JSON.parse(readFileSync(resolve(process.env.DUSK_PROTOCOL_DIR?.trim()
    || resolve(__dirname,'../../../protocol'),'idl/dusk.json'),'utf8')));
}
interface ActivitySource {
  event_key: string; observation_id: string; signature: string; slot: string;
  event_name: string; market: string; blockhash: string; block_time: Date; block_time_exact: string; payload: unknown;
}

/** Replay and live ingestion share this source-keyed, replica-serialized path. */
export async function projectMarketActivityBatch(client: PoolClient,limit = 500): Promise<number> {
  if (!Number.isSafeInteger(limit) || limit<1 || limit>500) throw new Error('Invalid activity batch limit');
  const active = identity(),swapBasis = activeSwapBasis();
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`dusk:market-activity:${JSON.stringify(active)}`]);
  const result = await client.query<ActivitySource & { stream_count: string; matching_count: string }>(`
    SELECT c.event_key,o.observation_id::text,o.event_name,o.transaction_signature AS signature,o.slot::text,
      o.blockhash,o.decoded_payload AS payload,o.decoded_payload->>'market' AS market,
      history.block_time,history.block_time::text AS block_time_exact,history.stream_count,history.matching_count
    FROM dusk_ingestion.canonical_events c
    JOIN dusk_ingestion.event_observations o USING(cluster,program_id,idl_hash,protocol_revision,event_key,observation_id)
    LEFT JOIN LATERAL (SELECT min(s.time) AS block_time,count(*)::text AS stream_count,
      count(*) FILTER(WHERE s.event_name=o.event_name AND s.slot=o.slot AND s.transaction_signature=o.transaction_signature
        AND s.market=o.decoded_payload->>'market' AND s.payload=o.decoded_payload)::text AS matching_count
      FROM dusk_ingestion.event_stream s WHERE
        (s.cluster,s.program_id,s.idl_hash,s.protocol_revision,s.event_key)=(c.cluster,c.program_id,c.idl_hash,c.protocol_revision,c.event_key)) history ON true
    WHERE c.cluster=$1 AND c.program_id=$2 AND c.idl_hash=$3 AND c.protocol_revision=$4
      AND c.commitment IN ('confirmed','finalized') AND o.commitment=c.commitment AND o.event_name=ANY($5::text[])
      AND NOT EXISTS(SELECT 1 FROM dusk_ingestion.market_activity_events a WHERE
        (a.cluster,a.program_id,a.idl_hash,a.protocol_revision,a.event_key)=(c.cluster,c.program_id,c.idl_hash,c.protocol_revision,c.event_key))
    ORDER BY o.slot,c.event_key LIMIT $6`,[...active,ACTIVITY_EVENTS,limit]);
  for (const row of result.rows) {
    if (row.stream_count !== '1' || row.matching_count !== '1' || !(row.block_time instanceof Date) || !Number.isFinite(row.block_time.getTime()) || typeof row.block_time_exact !== 'string')
      throw new Error('FINALIZED_INVARIANT: activity event lacks one matching event-time record');
    const parsed = parseActivityEvent(row.event_name,row.payload,row.slot,swapBasis);
    await client.query(`INSERT INTO dusk_ingestion.market_activity_events
      (cluster,program_id,idl_hash,protocol_revision,event_key,observation_id,event_name,market,signature,slot,blockhash,block_time,payload)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [...active,row.event_key,row.observation_id,row.event_name,parsed.market,row.signature,row.slot,row.blockhash,row.block_time_exact,JSON.stringify(row.payload)]);
  }
  return result.rows.length;
}
export async function projectFinalizedMarketActivity(limit = 500) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const count = await projectMarketActivityBatch(client,limit);
    await client.query('COMMIT');
    return count;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

export interface MarketActivityQuery extends HistoryDeploymentQuery { since?: string; until: string; market?: string }
type MetricAccumulator = { valued: bigint; unpriced: number; observations: number; estimated: number };
function emptyMetrics() {
  return Object.fromEntries(ACTIVITY_METRICS.map((metric) => [metric,{ valued: 0n,unpriced: 0,observations: 0,estimated: 0 }])) as Record<ActivityMetric,MetricAccumulator>;
}
function metricResponse(metrics: ReturnType<typeof emptyMetrics>) {
  return Object.fromEntries(ACTIVITY_METRICS.map((metric) => {
    const amount = metrics[metric];
    return [metric,{ observedUsd: amount.unpriced ? null : formatUsd(amount.valued),valuedUsd: formatUsd(amount.valued),
      unpricedObservations: amount.unpriced,observations: amount.observations,estimatedObservations: amount.estimated }];
  })) as Record<ActivityMetric,{ observedUsd: string | null; valuedUsd: string; unpricedObservations: number; observations: number; estimatedObservations: number }>;
}

function volumeResponse(metrics: ReturnType<typeof emptyMetrics>) {
  const response = metricResponse(metrics);
  return { spot: response.volume,credit: response.creditVolume,margin: response.marginVolume };
}

/** Caller owns a repeatable-read transaction. Range coverage is the stream's cursor. */
export async function readMarketActivity(client: PoolClient,options: MarketActivityQuery) {
  const active = identity(),swapBasis = activeSwapBasis();
  if (!/^[0-9a-f]{64}$/.test(options.deploymentIdentitySha256) || !Number.isFinite(Date.parse(options.until)) || options.since && (!Number.isFinite(Date.parse(options.since)) || Date.parse(options.since)>Date.parse(options.until)))
    throw new Error('Invalid native activity time range');
  if (options.market !== undefined && new PublicKey(options.market).toBase58() !== options.market)
    throw new Error('Invalid native activity market');
  const deployments = await historyDeploymentIdentities(client,options);
  const historyScan = await readHistoryScan(client);
  const changedSource = await client.query(`SELECT 1 FROM dusk_ingestion.market_activity_events a
    WHERE a.cluster=$1 AND a.program_id=$2 AND a.idl_hash=$3 AND a.protocol_revision=$4 AND (
      NOT EXISTS(SELECT 1 FROM dusk_ingestion.canonical_events c WHERE
        (c.cluster,c.program_id,c.idl_hash,c.protocol_revision,c.event_key,c.observation_id)=
        (a.cluster,a.program_id,a.idl_hash,a.protocol_revision,a.event_key,a.observation_id) AND c.commitment IN ('confirmed','finalized'))
      OR (SELECT count(*) FROM dusk_ingestion.event_stream s WHERE
        (s.cluster,s.program_id,s.idl_hash,s.protocol_revision,s.event_key)=
        (a.cluster,a.program_id,a.idl_hash,a.protocol_revision,a.event_key))<>1
      OR NOT EXISTS(SELECT 1 FROM dusk_ingestion.event_stream s WHERE
        (s.cluster,s.program_id,s.idl_hash,s.protocol_revision,s.event_key,s.slot,s.time,s.payload)=
        (a.cluster,a.program_id,a.idl_hash,a.protocol_revision,a.event_key,a.slot,a.block_time,a.payload)
        AND s.event_name=a.event_name AND s.transaction_signature=a.signature AND s.market=a.market)
    ) LIMIT 1`,active);
  if (changedSource.rowCount) throw new Error('FINALIZED_INVARIANT: recorded activity source changed');
  const coverage = await client.query<{ indexed: string; projected: string; first_slot: string | null; last_slot: string | null }>(`
    SELECT count(*)::text AS indexed,count(a.event_key)::text AS projected,min(o.slot)::text AS first_slot,max(o.slot)::text AS last_slot
    FROM dusk_ingestion.canonical_events c
    JOIN dusk_ingestion.event_observations o USING(cluster,program_id,idl_hash,protocol_revision,event_key,observation_id)
    LEFT JOIN dusk_ingestion.market_activity_events a USING(cluster,program_id,idl_hash,protocol_revision,event_key,observation_id)
    WHERE c.cluster=$1 AND c.program_id=$2 AND c.idl_hash=$3 AND c.protocol_revision=$4
      AND c.commitment IN ('confirmed','finalized') AND o.commitment=c.commitment AND o.event_name=ANY($5::text[])`,[...active,ACTIVITY_EVENTS]);
  const all = emptyMetrics(),byMarket = new Map<string,{ metrics: ReturnType<typeof emptyMetrics>; swaps: number; events: number }>();
  const prices = new Map<string,ActivityPriceBasis>();
  const digest = createHash('sha256').update(JSON.stringify([active,options.deploymentIdentitySha256,
    options.since ? new Date(options.since).toISOString() : null,new Date(options.until).toISOString(),options.market ?? null]));
  let afterSlot = '-1',afterKey = '',count = 0,swaps = 0,firstSourceSlot: string | null = null,lastSourceSlot: string | null = null;
  const references = activePriceReferences();
  do {
    const page = await client.query<ActivitySource & { price_key: string | null; price_slot: string | null; price_time: Date | null;
      price_payload: unknown; external_prices: ActivityExternalPrice[] }>(`
      SELECT a.*,a.observation_id::text,a.slot::text,p.event_key AS price_key,p.slot::text AS price_slot,p.time AS price_time,
        p.payload AS price_payload,COALESCE(external.quotes,'[]'::jsonb) AS external_prices
      FROM dusk_ingestion.market_activity_events a
      LEFT JOIN LATERAL (SELECT p.event_key,p.slot,p.time,p.payload FROM dusk_ingestion.streamed_market_snapshots p
        WHERE (p.cluster,p.program_id,p.idl_hash,p.protocol_revision)=(a.cluster,a.program_id,a.idl_hash,a.protocol_revision)
          AND p.market=a.market
          AND p.slot<a.slot AND p.time<=a.block_time
        ORDER BY p.slot DESC,p.observation_id DESC LIMIT 1) p ON true
      LEFT JOIN LATERAL (SELECT jsonb_agg(prices) AS quotes FROM (
        SELECT DISTINCT ON (x.mint) x.observation_id::text AS "observationId",x.mint,x.decimals,x.price_usd::text AS "priceUsd",
          (x.cluster<>'mainnet-beta') AS estimated,
          to_char(x.source_time AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "sourceTime",
          to_char(x.observed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "observedAt"
        FROM dusk_ingestion.price_observations x
        WHERE (x.cluster,x.program_id,x.idl_hash,x.protocol_revision)=(a.cluster,a.program_id,a.idl_hash,a.protocol_revision)
          AND x.mint IN (p.payload->'base'->>'asset_mint',p.payload->'quote'->>'asset_mint') AND x.quality='external-observation'
          AND (x.source LIKE 'dusk-provider.v1:jupiter:%' OR x.source LIKE 'dusk-provider.v1:birdeye:%')
          AND x.source_evidence->>'basis'='dusk-provider.v1' AND x.source_evidence->>'sourceCluster'='mainnet-beta'
          AND x.source_evidence->>'deploymentIdentitySha256'=ANY($10::text[])
          AND x.source_time<=a.block_time AND x.observed_at<=a.block_time
        ORDER BY x.mint,x.source_time DESC,x.observation_id DESC) prices) external ON true
      WHERE a.cluster=$1 AND a.program_id=$2 AND a.idl_hash=$3 AND a.protocol_revision=$4
        AND ($5::timestamptz IS NULL OR a.block_time>=$5) AND a.block_time<=$6
        AND ($7::text IS NULL OR a.market=$7) AND (a.slot,a.event_key)>($8::bigint,$9::text)
      ORDER BY a.slot,a.event_key LIMIT 500`,[...active,options.since ?? null,options.until,options.market ?? null,afterSlot,afterKey,deployments]);
    if (!page.rows.length) break;
    for (const row of page.rows) {
      let basis: ActivityPriceBasis | null = null;
      if (row.price_key && row.price_time && row.price_slot) {
        basis = prices.get(row.price_key) ?? null;
        if (!basis) {
          const projected = projectObservedPrices({ pin: loadPinnedProtocol(),observation: row.price_payload,
            blockTime: row.price_time.toISOString(),references });
          basis = { captureId: row.price_key,slot: Number(row.price_slot),blockTime: row.price_time.toISOString(),
            bound: projected.bound,prices: projected.prices,spotPrices: projected.spotPrices };
          prices.set(row.price_key,basis);
        }
      }
      const parsed = parseActivityEvent(row.event_name,row.payload,row.slot,swapBasis);
      if (parsed.market !== row.market) throw new Error('FINALIZED_INVARIANT: activity market changed');
      if (basis) basis = activityPriceBasis(basis,row.external_prices,row.block_time.toISOString());
      const metrics = valueActivityAmounts(parsed.amounts,basis,Number(row.slot),row.block_time.toISOString());
      const market = byMarket.get(row.market) ?? { metrics: emptyMetrics(),swaps: 0,events: 0 };
      byMarket.set(row.market,market);
      for (const value of metrics) {
        for (const target of [all[value.metric],market.metrics[value.metric]]) {
          target.observations++;
          if (value.usd === null) target.unpriced++;
          else { target.valued += usdUnits(value.usd); if (value.priceQuality && value.priceQuality !== 'external-observation') target.estimated++; }
        }
      }
      market.events++; count++;
      if (parsed.hasSwap) { market.swaps++; swaps++; }
      firstSourceSlot ??= row.slot; lastSourceSlot = row.slot;
      digest.update(JSON.stringify([row.event_key,row.observation_id,row.blockhash,row.block_time.toISOString(),metrics]));
      afterSlot = row.slot; afterKey = row.event_key;
    }
    if (page.rows.length<500) break;
    prices.clear();
  } while (true);
  const summary = coverage.rows[0];
  digest.update(JSON.stringify(historyScan));
  return {
    schemaVersion: 'dusk-market-activity.v1' as const,
    window: { since: options.since ? new Date(options.since).toISOString() : null,until: new Date(options.until).toISOString() },
    metrics: metricResponse(all),volumes: volumeResponse(all),events: count,swaps,
    markets: [...byMarket].sort(([a],[b]) => a.localeCompare(b)).map(([market,value]) => ({ market,metrics: metricResponse(value.metrics),volumes: volumeResponse(value.metrics),events: value.events,swaps: value.swaps })),
    coverage: { cluster: active[0],programId: active[1],idlSha256: active[2],protocolRevision: active[3],commitment: 'confirmed' as const,
      deploymentIdentitySha256: options.deploymentIdentitySha256,basis: 'recorded-economic-events.v1' as const,
      historyRangeComplete: summary.indexed === summary.projected && historyScanCovers(historyScan,options.since,options.until),historyScan,
      totalInterestAccrualAvailable: false as const,feeAllocationAvailable: false as const,
      priceBasis: 'latest-observed-prior-slot.v1' as const,volumeBasis: 'product-volumes.v1' as const,valuationBasis: 'provider-then-onchain.v1' as const,swapVolumeBasis: swapBasis,
      indexedEvents: summary.indexed,projectedEvents: summary.projected,pendingEvents: (BigInt(summary.indexed)-BigInt(summary.projected)).toString(),
      projectionComplete: summary.indexed === summary.projected,firstSourceSlot,lastSourceSlot,
      selectionHash: digest.digest('hex') },
  };
}

export async function listMarketActivity(options: MarketActivityQuery) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const result = await readMarketActivity(client,options);
    await client.query('COMMIT');
    return result;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
