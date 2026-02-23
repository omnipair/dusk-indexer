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

  return results;
}
