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

export function withDisplayPriceObservations(market: Record<string, any>, observations: DisplayPriceObservation[]) {
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
      || !Number.isFinite(at) || !Number.isFinite(sourceTime) || !Number.isFinite(observedAt)
      || sourceTime > observedAt || observedAt > at || at - sourceTime > DISPLAY_PRICE_MAX_AGE_MS
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

/** The same deployment and a quote already observed by the market's bank time. */
export async function withProviderDisplayPrices(market: Record<string, any>, deploymentIdentitySha256: string,
  client: Pool | PoolClient = pool) {
  const pin = loadPinnedProtocol();
  if (pin.cluster !== 'mainnet-beta' || market.state?.previewStatus !== 'available') return market;
  const result = await client.query<DisplayPriceObservation>(`SELECT DISTINCT ON (mint)
    observation_id::text AS "observationId", mint, decimals, price_usd::text AS "priceUsd",
    CASE WHEN source LIKE 'dusk-provider.v1:jupiter:%' THEN 'jupiter' ELSE 'birdeye' END AS provider,
    to_char(source_time AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "sourceTime",
    to_char(observed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "observedAt",
    source_evidence->>'deploymentIdentitySha256' AS "deploymentIdentitySha256"
    FROM dusk_ingestion.price_observations
    WHERE cluster=$1 AND program_id=$2 AND idl_hash=$3 AND protocol_revision=$4
      AND ((mint=$5 AND decimals=$9) OR (mint=$10 AND decimals=$11)) AND quality='external-observation'
      AND (source LIKE 'dusk-provider.v1:jupiter:%' OR source LIKE 'dusk-provider.v1:birdeye:%')
      AND source_evidence->>'basis'='dusk-provider.v1' AND source_evidence->>'sourceCluster'='mainnet-beta'
      AND source_evidence->>'externalMint'=mint AND source_evidence->>'deploymentIdentitySha256'=$6
      AND source_time<=observed_at AND observed_at<=$7::timestamptz
      AND source_time>=$7::timestamptz-($8::int*interval '1 millisecond')
    ORDER BY mint,source_time DESC,observation_id DESC`,
    [pin.cluster,pin.dusk.programId,pin.dusk.idlCanonicalSha256,pin.revision,
      market.baseMint,deploymentIdentitySha256,market.displayPrices.observedAt,DISPLAY_PRICE_MAX_AGE_MS,
      market.baseDecimals,market.quoteMint,market.quoteDecimals]);
  return withDisplayPriceObservations(market,result.rows);
}
