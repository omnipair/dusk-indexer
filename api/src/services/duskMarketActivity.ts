import { createHash } from 'node:crypto';
import { PoolClient } from 'pg';
import { PublicKey } from '@solana/web3.js';
import pool from '../config/database';
import { loadPinnedProtocol } from '../config/duskProtocol';
import { ACTIVITY_EVENTS, ACTIVITY_METRICS, ActivityMetric, ActivityPriceBasis, parseActivityEvent, valueActivityAmounts } from './duskActivityMath';
import { formatUsd, usdUnits } from './duskPortfolioMath';
import { StoredPriceCapture, verifyStoredPriceCapture } from './duskPrices';

const identity = () => {
  const pin = loadPinnedProtocol();
  return [pin.cluster,pin.dusk.programId,pin.dusk.idlCanonicalSha256,pin.revision];
};
interface ActivitySource {
  event_key: string; observation_id: string; signature: string; slot: string;
  event_name: string; market: string; blockhash: string; block_time: Date; payload: unknown;
}

/** Replay and live ingestion share this source-keyed, replica-serialized path. */
export async function projectMarketActivityBatch(client: PoolClient,limit = 500): Promise<number> {
  if (!Number.isSafeInteger(limit) || limit<1 || limit>500) throw new Error('Invalid activity batch limit');
  const active = identity();
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`dusk:market-activity:${JSON.stringify(active)}`]);
  const result = await client.query<ActivitySource & { stream_count: string; matching_count: string }>(`
    SELECT c.event_key,o.observation_id::text,o.event_name,o.transaction_signature AS signature,o.slot::text,
      o.blockhash,o.decoded_payload AS payload,o.decoded_payload->>'market' AS market,
      history.block_time,history.stream_count,history.matching_count
    FROM dusk_ingestion.canonical_events c
    JOIN dusk_ingestion.event_observations o USING(cluster,program_id,idl_hash,protocol_revision,event_key,observation_id)
    LEFT JOIN LATERAL (SELECT min(s.time) AS block_time,count(*)::text AS stream_count,
      count(*) FILTER(WHERE s.event_name=o.event_name AND s.slot=o.slot AND s.transaction_signature=o.transaction_signature
        AND s.market=o.decoded_payload->>'market' AND s.payload=o.decoded_payload)::text AS matching_count
      FROM dusk_ingestion.event_stream s WHERE
        (s.cluster,s.program_id,s.idl_hash,s.protocol_revision,s.event_key)=(c.cluster,c.program_id,c.idl_hash,c.protocol_revision,c.event_key)) history ON true
    WHERE c.cluster=$1 AND c.program_id=$2 AND c.idl_hash=$3 AND c.protocol_revision=$4
      AND c.commitment='finalized' AND o.commitment='finalized' AND o.event_name=ANY($5::text[])
      AND NOT EXISTS(SELECT 1 FROM dusk_ingestion.market_activity_events a WHERE
        (a.cluster,a.program_id,a.idl_hash,a.protocol_revision,a.event_key)=(c.cluster,c.program_id,c.idl_hash,c.protocol_revision,c.event_key))
    ORDER BY o.slot,c.event_key LIMIT $6`,[...active,ACTIVITY_EVENTS,limit]);
  for (const row of result.rows) {
    if (row.stream_count !== '1' || row.matching_count !== '1' || !(row.block_time instanceof Date) || !Number.isFinite(row.block_time.getTime()))
      throw new Error('FINALIZED_INVARIANT: activity event lacks one matching event-time record');
    const parsed = parseActivityEvent(row.event_name,row.payload,row.slot);
    await client.query(`INSERT INTO dusk_ingestion.market_activity_events
      (cluster,program_id,idl_hash,protocol_revision,event_key,observation_id,event_name,market,signature,slot,blockhash,block_time,payload)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [...active,row.event_key,row.observation_id,row.event_name,parsed.market,row.signature,row.slot,row.blockhash,row.block_time,JSON.stringify(row.payload)]);
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

export interface MarketActivityQuery { since?: string; until: string; market?: string; maxPriceAgeSeconds?: number; deploymentIdentitySha256: string }
type MetricAccumulator = { valued: bigint; unpriced: number; observations: number };
function emptyMetrics() {
  return Object.fromEntries(ACTIVITY_METRICS.map((metric) => [metric,{ valued: 0n,unpriced: 0,observations: 0 }])) as Record<ActivityMetric,MetricAccumulator>;
}
function metricResponse(metrics: ReturnType<typeof emptyMetrics>) {
  return Object.fromEntries(ACTIVITY_METRICS.map((metric) => {
    const amount = metrics[metric];
    return [metric,{ observedUsd: amount.unpriced ? null : formatUsd(amount.valued),valuedUsd: formatUsd(amount.valued),
      unpricedObservations: amount.unpriced,observations: amount.observations }];
  })) as Record<ActivityMetric,{ observedUsd: string | null; valuedUsd: string; unpricedObservations: number; observations: number }>;
}

/** Caller owns a repeatable-read transaction. A cursor heartbeat is not range coverage. */
export async function readMarketActivity(client: PoolClient,options: MarketActivityQuery) {
  const active = identity(),maxPriceAgeSeconds = options.maxPriceAgeSeconds ?? 3600;
  if (!/^[0-9a-f]{64}$/.test(options.deploymentIdentitySha256) || !Number.isFinite(Date.parse(options.until)) || options.since && (!Number.isFinite(Date.parse(options.since)) || Date.parse(options.since)>Date.parse(options.until))
    || !Number.isSafeInteger(maxPriceAgeSeconds) || maxPriceAgeSeconds<1 || maxPriceAgeSeconds>86400)
    throw new Error('Invalid native activity time range');
  if (options.market !== undefined && new PublicKey(options.market).toBase58() !== options.market)
    throw new Error('Invalid native activity market');
  const conflicts = await client.query(`SELECT 1 FROM dusk_ingestion.price_capture_observations
    WHERE cluster=$1 AND program_id=$2 AND idl_hash=$3 AND protocol_revision=$4
    GROUP BY market,slot HAVING count(DISTINCT (blockhash,preview_hash,reference_config))>1 LIMIT 1`,active);
  if (conflicts.rowCount) throw new Error('FINALIZED_INVARIANT: contradictory activity price evidence');
  const changedSource = await client.query(`SELECT 1 FROM dusk_ingestion.market_activity_events a
    WHERE a.cluster=$1 AND a.program_id=$2 AND a.idl_hash=$3 AND a.protocol_revision=$4 AND (
      NOT EXISTS(SELECT 1 FROM dusk_ingestion.canonical_events c WHERE
        (c.cluster,c.program_id,c.idl_hash,c.protocol_revision,c.event_key,c.observation_id)=
        (a.cluster,a.program_id,a.idl_hash,a.protocol_revision,a.event_key,a.observation_id) AND c.commitment='finalized')
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
      AND c.commitment='finalized' AND o.commitment='finalized' AND o.event_name=ANY($5::text[])`,[...active,ACTIVITY_EVENTS]);
  const all = emptyMetrics(),byMarket = new Map<string,{ metrics: ReturnType<typeof emptyMetrics>; swaps: number; events: number }>();
  const prices = new Map<string,ActivityPriceBasis>();
  const digest = createHash('sha256').update(JSON.stringify([active,options.deploymentIdentitySha256,
    options.since ? new Date(options.since).toISOString() : null,new Date(options.until).toISOString(),options.market ?? null,maxPriceAgeSeconds]));
  let afterSlot = '-1',afterKey = '',count = 0,swaps = 0,firstSourceSlot: string | null = null,lastSourceSlot: string | null = null;
  do {
    const page = await client.query<ActivitySource & { capture_id: string | null }>(`
      SELECT a.*,a.observation_id::text,a.slot::text,p.capture_id::text
      FROM dusk_ingestion.market_activity_events a
      LEFT JOIN LATERAL (SELECT p.capture_id FROM dusk_ingestion.price_capture_observations p
        WHERE (p.cluster,p.program_id,p.idl_hash,p.protocol_revision,p.market)=(a.cluster,a.program_id,a.idl_hash,a.protocol_revision,a.market)
          AND p.deployment_identity_sha256=$11
          AND p.slot<a.slot AND p.block_time<=a.block_time AND p.block_time>=a.block_time-($8::int*interval '1 second')
        ORDER BY p.slot DESC,p.capture_id DESC LIMIT 1) p ON true
      WHERE a.cluster=$1 AND a.program_id=$2 AND a.idl_hash=$3 AND a.protocol_revision=$4
        AND ($5::timestamptz IS NULL OR a.block_time>=$5) AND a.block_time<=$6
        AND ($7::text IS NULL OR a.market=$7) AND (a.slot,a.event_key)>($9::bigint,$10::text)
      ORDER BY a.slot,a.event_key LIMIT 500`,[...active,options.since ?? null,options.until,options.market ?? null,maxPriceAgeSeconds,afterSlot,afterKey,options.deploymentIdentitySha256]);
    if (!page.rows.length) break;
    for (const row of page.rows) {
      let basis: ActivityPriceBasis | null = null;
      if (row.capture_id) {
        basis = prices.get(row.capture_id) ?? null;
        if (!basis) {
          const captured = await client.query<StoredPriceCapture>(`SELECT *,slot::text,market_slot::text,capture_id::text
            FROM dusk_ingestion.price_capture_observations WHERE capture_id=$1`,[row.capture_id]);
          const capture = captured.rows[0];
          if (!capture || capture.market !== row.market || capture.deployment_identity_sha256 !== options.deploymentIdentitySha256)
            throw new Error('FINALIZED_INVARIANT: activity price capture disappeared or changed deployment');
          const { source,projected } = verifyStoredPriceCapture(capture);
          basis = { captureId: row.capture_id,slot: source.slot,blockTime: source.blockTime,bound: projected.bound,prices: projected.prices };
          prices.set(row.capture_id,basis);
        }
      }
      const parsed = parseActivityEvent(row.event_name,row.payload,row.slot);
      if (parsed.market !== row.market) throw new Error('FINALIZED_INVARIANT: activity market changed');
      const metrics = valueActivityAmounts(parsed.amounts,basis,Number(row.slot),row.block_time.toISOString(),maxPriceAgeSeconds);
      const market = byMarket.get(row.market) ?? { metrics: emptyMetrics(),swaps: 0,events: 0 };
      byMarket.set(row.market,market);
      for (const value of metrics) {
        for (const target of [all[value.metric],market.metrics[value.metric]]) {
          target.observations++;
          if (value.usd === null) target.unpriced++;
          else target.valued += usdUnits(value.usd);
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
  return {
    schemaVersion: 'dusk-market-activity.v1' as const,
    window: { since: options.since ? new Date(options.since).toISOString() : null,until: new Date(options.until).toISOString(),maxPriceAgeSeconds },
    metrics: metricResponse(all),events: count,swaps,
    markets: [...byMarket].sort(([a],[b]) => a.localeCompare(b)).map(([market,value]) => ({ market,metrics: metricResponse(value.metrics),events: value.events,swaps: value.swaps })),
    coverage: { cluster: active[0],programId: active[1],idlSha256: active[2],protocolRevision: active[3],commitment: 'finalized' as const,
      deploymentIdentitySha256: options.deploymentIdentitySha256,basis: 'recorded-economic-events.v1' as const,historyRangeComplete: false as const,
      totalInterestAccrualAvailable: false as const,feeAllocationAvailable: false as const,
      priceBasis: 'latest-captured-prior-slot.v1' as const,
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
