import type { PoolClient } from 'pg';
import { loadPinnedProtocol } from '../config/duskProtocol';
import { activePriceReferences, projectReferencePrices } from './duskPriceMath';
import { readProviderPriceObservationBatch, withDisplayPriceObservations } from './duskDisplayPrices';
import { historyDeploymentIdentities, HistoryDeploymentQuery } from './duskHistoryDeployment';

export interface EventHistoricalPrices {
  basis: 'last-observed-before-event.v1';
  asOf: string;
  prices: {
    mint: string; decimals: number; priceUsd: string;
    quality: 'external-observation' | 'configured-reference';
    sourceTime: string; observedAt: string;
    observationId?: string; deploymentIdentitySha256?: string;
  }[];
}

/** Historical token amounts are valued only with dated evidence already
 * available at that event, never today's display prices. Missing evidence
 * leaves the token amounts usable without inventing historical dollars. */
export async function eventHistoryPrices(client: PoolClient,
  rows: { event_key: string; payload: Record<string,unknown>; block_time: Date }[],
  query: HistoryDeploymentQuery): Promise<Map<string,EventHistoricalPrices>> {
  const result = new Map<string,EventHistoricalPrices>();
  if (!rows.length) return result;
  const pin = loadPinnedProtocol(),references = activePriceReferences();
  const deployments = await historyDeploymentIdentities(client,query,pin);
  const markets = await client.query<{ market: string; payload: unknown }>(`
    SELECT market,payload FROM dusk_ingestion.streamed_markets
    WHERE cluster=$1 AND program_id=$2 AND idl_hash=$3 AND protocol_revision=$4 AND market=ANY($5::text[])`,
    [pin.cluster,pin.dusk.programId,pin.dusk.idlCanonicalSha256,pin.revision,[...new Set(rows.map(row => String(row.payload.market)))]]);
  const created = new Map(markets.rows.map(row => [row.market,row.payload]));
  const views = new Map<string,{ asOf: string; view: Record<string,any> }>();
  for (const row of rows) {
    const market = created.get(String(row.payload.market)),asOf = row.block_time.toISOString();
    if (!market) continue;
    const key = `${row.payload.market}:${asOf}`;
    if (!views.has(key)) {
      const projected = projectReferencePrices({ pin,market,blockTime: asOf,references });
      const view = { ...projected.bound,state: { previewStatus: 'available' },displayPrices: { observedAt: asOf,prices: projected.prices } };
      views.set(key,{ asOf,view });
    }
  }
  const entries = [...views.entries()];
  const external = await readProviderPriceObservationBatch(entries.map(([,entry]) => entry.view),deployments,client,'historical');
  const dates = new Map<string,EventHistoricalPrices>();
  for (const [index,[key,{ asOf,view }]] of entries.entries()) {
    const values = withDisplayPriceObservations(view,external[index],deployments,'historical').displayPrices.prices;
    const priced: EventHistoricalPrices = { basis: 'last-observed-before-event.v1',asOf,prices: values.map((value: any) => {
      const reference = value.reference;
      return { mint: value.mint,decimals: value.decimals,priceUsd: value.priceUsd,quality: value.quality,
        sourceTime: reference.sourceTime ?? references.effectiveFrom,
        observedAt: reference.observedAt ?? references.effectiveFrom,
        ...(reference.observationId ? { observationId: reference.observationId,deploymentIdentitySha256: reference.deploymentIdentitySha256 } : {}) };
    }) };
    dates.set(key,priced);
  }
  for (const row of rows) {
    const priced = dates.get(`${row.payload.market}:${row.block_time.toISOString()}`);
    if (priced) result.set(row.event_key,priced);
  }
  return result;
}
