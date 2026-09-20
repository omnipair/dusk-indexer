import { PoolClient } from 'pg';
import { PublicKey } from '@solana/web3.js';
import { loadPinnedProtocol } from '../config/duskProtocol';
import { fetchBirdeyeHistoricalPrice } from './birdeyePriceService';
import { positiveDecimal, PriceReferences } from './duskPriceMath';

export interface ExternalPrice {
  mint: string; decimals: number; priceUsd: string; provider: 'jupiter' | 'birdeye';
  externalMint: string; sourceTime: string; observedAt: string;
}
export interface ExternalPriceTarget { mint: string; externalMint: string; decimals: number }

/** Devnet mints require an explicit mainnet mapping; symbols are never identity. */
export function externalPriceTargets(cluster: string, references: PriceReferences,
  assets: { mint: string; decimals: number }[]): ExternalPriceTarget[] {
  return assets.flatMap((asset) => {
    const externalMint = cluster === 'mainnet-beta' ? asset.mint
      : references.references.find((reference) => reference.mint === asset.mint)?.externalMint;
    return externalMint ? [{ ...asset,externalMint: new PublicKey(externalMint).toBase58() }] : [];
  });
}

function decimal(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value<=0) return null;
  // Convert JSON numeric prices without introducing exponent-form strings into
  // the exact decimal accounting pipeline.
  const [digits,exponent = '0'] = String(value).toLowerCase().split('e');
  const [whole,fraction = ''] = digits.split('.');
  const point = whole.length+Number(exponent),all = whole+fraction;
  const result = point<=0 ? `0.${'0'.repeat(-point)}${all}`
    : point>=all.length ? all+'0'.repeat(point-all.length) : `${all.slice(0,point)}.${all.slice(point)}`;
  try { return positiveDecimal(result); } catch { return null; }
}

/** Provider failures leave the independently captured on-chain fallback usable. */
export async function fetchExternalPrices(targets: ExternalPriceTarget[],options: {
  fetchImpl?: typeof fetch; now?: () => Date;
  birdeye?: typeof fetchBirdeyeHistoricalPrice;
} = {}): Promise<ExternalPrice[]> {
  const now = options.now ?? (() => new Date()),result: ExternalPrice[] = [];
  if (!targets.length) return result;
  const fetchImpl = options.fetchImpl ?? fetch;
  // Jupiter accepts at most 50 mints per request.
  const mints = [...new Set(targets.map((target) => target.externalMint))];
  const quotes = new Map<string,string>();
  for (let offset = 0; offset<mints.length; offset+=50) {
    const controller = new AbortController(),timer = setTimeout(() => controller.abort(),3000);
    try {
      const url = new URL('/price/v3',process.env.JUPITER_API_URL || 'https://api.jup.ag');
      url.searchParams.set('ids',mints.slice(offset,offset+50).join(','));
      const response = await fetchImpl(url,{ signal: controller.signal,
        headers: process.env.JUPITER_API_KEY ? { 'x-api-key': process.env.JUPITER_API_KEY } : {} });
      if (response.ok) {
        const data = await response.json() as Record<string,{ usdPrice?: unknown }>;
        for (const mint of mints.slice(offset,offset+50)) {
          const price = decimal(data?.[mint]?.usdPrice);
          if (price) quotes.set(mint,price);
        }
      }
    } catch { /* Missing provider data is not a zero price. */ }
    finally { clearTimeout(timer); }
  }
  for (const target of targets) {
    let priceUsd = quotes.get(target.externalMint),provider: ExternalPrice['provider'] = 'jupiter';
    if (!priceUsd) {
      const fallback = await (options.birdeye ?? fetchBirdeyeHistoricalPrice)(target.externalMint,now());
      priceUsd = decimal(fallback?.priceUsd) ?? undefined;
      provider = 'birdeye';
    }
    if (!priceUsd) continue;
    // Current quotes become usable only from observation time, never retroactively.
    const observedAt = now().toISOString();
    result.push({ ...target,priceUsd,provider,sourceTime: observedAt,observedAt });
  }
  return result;
}

export async function storeExternalPrices(client: PoolClient,prices: ExternalPrice[],deploymentIdentitySha256: string) {
  const pin = loadPinnedProtocol();
  for (const price of prices) {
    await client.query(`INSERT INTO dusk_ingestion.price_observations
      (cluster,program_id,idl_hash,protocol_revision,mint,decimals,observed_at,source_time,price_usd,quality,source,source_evidence)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'external-observation',$10,$11)
      ON CONFLICT(cluster,program_id,idl_hash,protocol_revision,mint,source,source_time) DO NOTHING`,
      [pin.cluster,pin.dusk.programId,pin.dusk.idlCanonicalSha256,pin.revision,price.mint,price.decimals,
        price.observedAt,price.sourceTime,price.priceUsd,`dusk-provider.v1:${price.provider}:${price.externalMint}:${deploymentIdentitySha256}`,
        JSON.stringify({ basis: 'dusk-provider.v1',externalMint: price.externalMint,sourceCluster: 'mainnet-beta',deploymentIdentitySha256 })]);
  }
}
