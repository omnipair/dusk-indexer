import type { Pool, PoolClient } from 'pg';
import pool from '../config/database';
import { loadPinnedProtocol } from '../config/duskProtocol';
import { positiveDecimal } from './duskPriceMath';

/** Provider observations are display inputs, never protocol risk or execution prices. */
export const DISPLAY_PRICE_MAX_AGE_MS = 90_000;
export interface DisplayPriceObservation {
  observationId: string; mint: string; decimals: number; priceUsd: string;
  provider: 'jupiter' | 'birdeye'; sourceTime: string; observedAt: string;
  deploymentIdentitySha256: string;
}
export type ProviderPriceMode = 'live' | 'historical';

export function withDisplayPriceObservations(market: Record<string, any>, observations: DisplayPriceObservation[], eligibleDeployments?: readonly string[], mode: ProviderPriceMode = 'live') {
  const display = market.displayPrices;
  if (market.state?.previewStatus !== 'available' || !display || !Array.isArray(display.prices)) return market;
  const at = Date.parse(display.observedAt);
  const prices = new Map<string, any>(display.prices.map((price: any) => [price.mint, price]));
  for (const observation of observations) {
    const side = observation.mint === market.baseMint ? 'base' : observation.mint === market.quoteMint ? 'quote' : null;
    const sourceTime = Date.parse(observation.sourceTime), observedAt = Date.parse(observation.observedAt);
    if (!side || observation.decimals !== market[`${side}Decimals`] || !/^\d+$/.test(observation.observationId)
      || !['jupiter', 'birdeye'].includes(observation.provider)
      || !/^[a-f0-9]{64}$/.test(observation.deploymentIdentitySha256)
      || eligibleDeployments && !eligibleDeployments.includes(observation.deploymentIdentitySha256)
      || !Number.isFinite(at) || !Number.isFinite(sourceTime) || !Number.isFinite(observedAt)
      || sourceTime > observedAt || observedAt > at || mode === 'live' && at - sourceTime > DISPLAY_PRICE_MAX_AGE_MS
      || prices.get(observation.mint)?.quality === 'configured-reference') continue;
    let priceUsd: string;
    try { priceUsd = positiveDecimal(observation.priceUsd); } catch { continue; }
    prices.set(observation.mint, { mint: observation.mint, decimals: observation.decimals, priceUsd,
      quality: 'external-observation', spotPriceNad: null,
      reference: { mint: observation.mint, priceUsd,
        note: `${observation.provider} observation ${observation.observationId}`, provider: observation.provider,
        observationId: observation.observationId, sourceTime: observation.sourceTime, observedAt: observation.observedAt,
        deploymentIdentitySha256: observation.deploymentIdentitySha256 } });
  }
  return { ...market, displayPrices: { ...display, prices: [...prices.values()] } };
}

/** Live quotes expire after 90 seconds. Historical reads use the last quote
 * actually observed before that point, as economic-event valuation does;
 * present-day observations are never backdated into an old bank. */
export async function readProviderPriceObservations(market: Record<string, any>, deploymentIdentities: readonly string[],
  client: Pool | PoolClient = pool, mode: ProviderPriceMode = 'live') {
  return (await readProviderPriceObservationBatch([market],deploymentIdentities,client,mode))[0];
}

/** One indexed latest-eligible lookup per asset/cutoff. A history page shares
 * one round trip without scanning every older quote for each event. */
export async function readProviderPriceObservationBatch(markets: readonly Record<string, any>[],deploymentIdentities: readonly string[],
  client: Pool | PoolClient = pool,mode: ProviderPriceMode = 'live'): Promise<DisplayPriceObservation[][]> {
  const pin = loadPinnedProtocol();
  const observations: DisplayPriceObservation[][] = markets.map(() => []);
  if (pin.cluster !== 'mainnet-beta') return observations;
  const requests = markets.flatMap((market,index) => market.state?.previewStatus !== 'available' ? []
    : [ { request_index: index,mint: market.baseMint,decimals: market.baseDecimals,as_of: market.displayPrices.observedAt },
      { request_index: index,mint: market.quoteMint,decimals: market.quoteDecimals,as_of: market.displayPrices.observedAt } ]);
  if (!requests.length) return observations;
  if (!deploymentIdentities.length || deploymentIdentities.some(value => !/^[a-f0-9]{64}$/.test(value))) throw new Error('Invalid provider deployment selection');
  const result = await client.query<DisplayPriceObservation & { request_index: number }>(`SELECT DISTINCT ON (r.request_index,p.mint)
    r.request_index,p.observation_id::text AS "observationId",p.mint,p.decimals,p.price_usd::text AS "priceUsd",
    CASE WHEN p.source LIKE 'dusk-provider.v1:jupiter:%' THEN 'jupiter' ELSE 'birdeye' END AS provider,
    to_char(p.source_time AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "sourceTime",
    to_char(p.observed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "observedAt",
    p.source_evidence->>'deploymentIdentitySha256' AS "deploymentIdentitySha256"
    FROM jsonb_to_recordset($5::jsonb) AS r(request_index int,mint text,decimals int,as_of timestamptz)
    CROSS JOIN LATERAL (SELECT observation_id,mint,decimals,price_usd,source,source_time,observed_at,source_evidence
    FROM dusk_ingestion.price_observations
    WHERE cluster=$1 AND program_id=$2 AND idl_hash=$3 AND protocol_revision=$4
      AND mint=r.mint AND decimals=r.decimals AND quality='external-observation'
      AND (source LIKE 'dusk-provider.v1:jupiter:%' OR source LIKE 'dusk-provider.v1:birdeye:%')
      AND source_evidence->>'basis'='dusk-provider.v1' AND source_evidence->>'sourceCluster'='mainnet-beta'
      AND source_evidence->>'externalMint'=mint AND source_evidence->>'deploymentIdentitySha256'=ANY($6::text[])
      AND source_time<=r.as_of AND source_time<=observed_at AND observed_at<=r.as_of
      AND ($7::int IS NULL OR source_time>=r.as_of-($7::int*interval '1 millisecond'))
    ORDER BY source_time DESC,observation_id DESC LIMIT 1) p
    ORDER BY r.request_index,p.mint,p.source_time DESC,p.observation_id DESC`,
    [pin.cluster,pin.dusk.programId,pin.dusk.idlCanonicalSha256,pin.revision,
      JSON.stringify(requests),deploymentIdentities,mode === 'live' ? DISPLAY_PRICE_MAX_AGE_MS : null]);
  for (const { request_index,...observation } of result.rows) observations[request_index].push(observation);
  return observations;
}

export async function withProviderDisplayPrices(market: Record<string, any>, deploymentIdentitySha256: string,
  client: Pool | PoolClient = pool) {
  return withDisplayPriceObservations(market,await readProviderPriceObservations(market,[deploymentIdentitySha256],client),[deploymentIdentitySha256]);
}
