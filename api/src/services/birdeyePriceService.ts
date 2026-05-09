const DEFAULT_BIRDEYE_API_URL = 'https://public-api.birdeye.so';
const DEFAULT_TIMEOUT_MS = 5000;

export interface BirdeyeHistoricalPrice {
  mint: string;
  priceUsd: number;
  provider: 'birdeye';
}

export interface BirdeyePriceOptions {
  apiKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

function parsePositiveNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return null;
}

export function extractBirdeyePrice(responseBody: unknown): number | null {
  const body = responseBody as any;
  const data = body?.data ?? body;

  const directValue = parsePositiveNumber(data?.value ?? data?.price ?? data?.usdPrice);
  if (directValue !== null) {
    return directValue;
  }

  const items = Array.isArray(data?.items)
    ? data.items
    : Array.isArray(data?.history)
      ? data.history
      : Array.isArray(data)
        ? data
        : [];

  for (const item of items) {
    const itemValue = parsePositiveNumber(item?.value ?? item?.price ?? item?.usdPrice);
    if (itemValue !== null) {
      return itemValue;
    }
  }

  return null;
}

export async function fetchBirdeyeHistoricalPrice(
  mint: string,
  timestamp: Date,
  options: BirdeyePriceOptions = {}
): Promise<BirdeyeHistoricalPrice | null> {
  const apiKey = options.apiKey ?? process.env.BIRDEYE_API_KEY ?? '';
  if (!apiKey) {
    console.warn('BIRDEYE_API_KEY is not set; skipping historical price fetch');
    return null;
  }

  const baseUrl = (options.baseUrl ?? process.env.BIRDEYE_API_URL ?? DEFAULT_BIRDEYE_API_URL).replace(/\/$/, '');
  const timeoutMs = options.timeoutMs ?? parseInt(process.env.BIRDEYE_TIMEOUT_MS || `${DEFAULT_TIMEOUT_MS}`, 10);
  const fetchFn = options.fetchImpl ?? fetch;
  const bucketSeconds = Math.floor(timestamp.getTime() / 1000);
  const params = new URLSearchParams({
    address: mint,
    address_type: 'token',
    type: '1H',
    time_from: String(bucketSeconds),
    time_to: String(bucketSeconds + 3600),
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchFn(`${baseUrl}/defi/history_price?${params.toString()}`, {
      signal: controller.signal,
      headers: {
        'X-API-KEY': apiKey,
        'x-chain': 'solana',
      },
    });

    if (!response.ok) {
      console.warn(`Birdeye historical price returned ${response.status} for ${mint}`);
      return null;
    }

    const body = await response.json();
    const priceUsd = extractBirdeyePrice(body);
    if (priceUsd === null) {
      console.warn(`Birdeye historical price missing for ${mint}`);
      return null;
    }

    return {
      mint,
      priceUsd,
      provider: 'birdeye',
    };
  } catch (error: any) {
    if (error?.name === 'AbortError') {
      console.warn(`Birdeye historical price timeout for ${mint}`);
      return null;
    }
    console.error(`Error fetching Birdeye historical price for ${mint}:`, error?.message ?? error);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
