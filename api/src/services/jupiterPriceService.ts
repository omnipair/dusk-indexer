import pool from '../config/database';

const JUPITER_API_URL = process.env.JUPITER_API_URL || 'https://api.jup.ag';
const JUPITER_API_KEY = process.env.JUPITER_API_KEY || '';
const JUPITER_TIMEOUT_MS = parseInt(process.env.JUPITER_TIMEOUT_MS || '3000', 10);
const PRICE_CACHE_TTL_MS = parseInt(process.env.PRICE_CACHE_TTL_MS || '30000', 10);

interface PriceCacheEntry {
  price: number;
  decimals: number;
  timestamp: number;
}

const priceCache = new Map<string, PriceCacheEntry>();

function getCachedPrice(mint: string): PriceResult | null {
  const entry = priceCache.get(mint);
  if (entry && Date.now() - entry.timestamp < PRICE_CACHE_TTL_MS) {
    return { price: entry.price, decimals: entry.decimals };
  }
  return null;
}

function setCachedPrice(mint: string, price: number, decimals: number): void {
  priceCache.set(mint, { price, decimals, timestamp: Date.now() });
}

interface JupiterV3PriceData {
  usdPrice: number;
  decimals: number;
  blockId?: number;
  priceChange24h?: number;
}

export type PriceResult = { price: number; decimals: number };

/**
 * Prices the indexer derived itself, for mints Jupiter does not list.
 *
 * A cluster of its own mints has no external price feed, so anything valued
 * in USD — TVL, volume, fees, portfolios — would read as zero. The indexer
 * already knows what these assets trade for, because it recorded the trades:
 * `token_price_snapshots` anchors the assets whose value is known and prices
 * the rest from pool ratios. Jupiter stays authoritative where it answers.
 */
async function fetchDerivedPrices(
  mints: string[],
): Promise<Map<string, PriceResult>> {
  const derived = new Map<string, PriceResult>();
  if (mints.length === 0) return derived;
  try {
    const result = await pool.query<{
      mint: string;
      price_usd: string;
      decimals: number | null;
    }>(
      `SELECT DISTINCT ON (mint) mint, price_usd, decimals
         FROM token_price_snapshots
        WHERE mint = ANY($1)
        ORDER BY mint, bucket DESC`,
      [mints],
    );
    for (const row of result.rows) {
      const price = Number(row.price_usd);
      if (!Number.isFinite(price) || price <= 0) continue;
      derived.set(row.mint, { price, decimals: row.decimals ?? 6 });
    }
  } catch (error) {
    // The table is absent on deployments without the Dusk compatibility
    // layer; that is not an error, it just means there is nothing to add.
    const message = error instanceof Error ? error.message : String(error);
    if (!/does not exist/i.test(message)) {
      console.warn(`Derived price lookup failed: ${message}`);
    }
  }
  return derived;
}

/**
 * Fetch prices for multiple token mints in a single Jupiter V3 API call.
 * Results are cached individually. Returns a map of mint -> price data.
 */
export async function fetchTokenPrices(mints: string[]): Promise<Map<string, PriceResult>> {
  const results = new Map<string, PriceResult>();

  const uncachedMints: string[] = [];
  for (const mint of mints) {
    const cached = getCachedPrice(mint);
    if (cached !== null) {
      results.set(mint, cached);
    } else {
      uncachedMints.push(mint);
    }
  }

  if (uncachedMints.length === 0) {
    return results;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), JUPITER_TIMEOUT_MS);

    const headers: Record<string, string> = {};
    if (JUPITER_API_KEY) {
      headers['x-api-key'] = JUPITER_API_KEY;
    }

    const ids = uncachedMints.join(',');
    const response = await fetch(`${JUPITER_API_URL}/price/v3?ids=${ids}`, {
      signal: controller.signal,
      headers,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      console.warn(`Jupiter Price V3 returned ${response.status} for mints: ${ids}`);
      return results;
    }

    const data = await response.json() as Record<string, JupiterV3PriceData>;

    for (const mint of uncachedMints) {
      const tokenData = data?.[mint];
      if (tokenData && tokenData.usdPrice && !isNaN(tokenData.usdPrice) && tokenData.usdPrice > 0) {
        const result: PriceResult = {
          price: tokenData.usdPrice,
          decimals: tokenData.decimals ?? 6,
        };
        setCachedPrice(mint, result.price, result.decimals);
        results.set(mint, result);
      }
    }
  } catch (error: any) {
    if (error.name === 'AbortError') {
      console.warn(`Jupiter Price V3 timeout for mints: ${uncachedMints.join(',')}`);
    } else {
      console.error(`Error fetching prices:`, error.message);
    }
  }

  // Anything Jupiter did not price — an unlisted mint, or a request that
  // failed outright — falls back to what this indexer observed.
  const stillMissing = mints.filter((mint) => !results.has(mint));
  if (stillMissing.length > 0) {
    for (const [mint, price] of await fetchDerivedPrices(stillMissing)) {
      setCachedPrice(mint, price.price, price.decimals);
      results.set(mint, price);
    }
  }

  return results;
}
