const DEFAULT_BIRDEYE_API_URL = 'https://public-api.birdeye.so';
const DEFAULT_TIMEOUT_MS = 5000;

export interface BirdeyeHistoricalPrice {
  mint: string;
  priceUsd: number;
  provider: 'birdeye';
}

export interface BirdeyeHistoricalPricePoint extends BirdeyeHistoricalPrice {
  timestamp: Date;
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
  const points = extractBirdeyePricePoints(responseBody);
  if (points.length > 0) {
    return points[0].priceUsd;
  }

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

function parseTimestamp(value: unknown): Date | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return new Date(value > 10_000_000_000 ? value : value * 1000);
  }
  if (typeof value === 'string') {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) {
      return new Date(numeric > 10_000_000_000 ? numeric : numeric * 1000);
    }
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }
  return null;
}

export function extractBirdeyePricePoints(responseBody: unknown): Array<{ timestamp: Date; priceUsd: number }> {
  const body = responseBody as any;
  const data = body?.data ?? body;
  const items = Array.isArray(data?.items)
    ? data.items
    : Array.isArray(data?.history)
      ? data.history
      : Array.isArray(data)
        ? data
        : [];

  const points: Array<{ timestamp: Date; priceUsd: number }> = [];
  for (const item of items) {
    const priceUsd = parsePositiveNumber(item?.value ?? item?.price ?? item?.usdPrice);
    const timestamp = parseTimestamp(
      item?.unixTime ?? item?.unix_time ?? item?.timestamp ?? item?.time ?? item?.t
    );
    if (priceUsd !== null && timestamp !== null) {
      points.push({ timestamp, priceUsd });
    }
  }

  return points;
}

function createHistoryUrl(baseUrl: string, mint: string, from: Date, to: Date): string {
  const fromSeconds = Math.floor(from.getTime() / 1000);
  const toSeconds = Math.floor(to.getTime() / 1000);
  const params = new URLSearchParams({
    address: mint,
    address_type: 'token',
    type: '1H',
    time_from: String(fromSeconds),
    time_to: String(toSeconds),
  });

  return `${baseUrl}/defi/history_price?${params.toString()}`;
}

async function fetchBirdeyeJson(
  mint: string,
  url: string,
  options: BirdeyePriceOptions
): Promise<unknown | null> {
  const apiKey = options.apiKey ?? process.env.BIRDEYE_API_KEY ?? '';
  if (!apiKey) {
    console.warn('BIRDEYE_API_KEY is not set; skipping historical price fetch');
    return null;
  }

  const timeoutMs = options.timeoutMs ?? parseInt(process.env.BIRDEYE_TIMEOUT_MS || `${DEFAULT_TIMEOUT_MS}`, 10);
  const fetchFn = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchFn(url, {
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

    return response.json();
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

export async function fetchBirdeyeHistoricalPrice(
  mint: string,
  timestamp: Date,
  options: BirdeyePriceOptions = {}
): Promise<BirdeyeHistoricalPrice | null> {
  const baseUrl = (options.baseUrl ?? process.env.BIRDEYE_API_URL ?? DEFAULT_BIRDEYE_API_URL).replace(/\/$/, '');
  const bucketSeconds = Math.floor(timestamp.getTime() / 1000);
  const url = createHistoryUrl(baseUrl, mint, new Date(bucketSeconds * 1000), new Date((bucketSeconds + 3600) * 1000));
  const body = await fetchBirdeyeJson(mint, url, options);
  if (!body) {
    return null;
  }

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
}

export async function fetchBirdeyeHistoricalPriceRange(
  mint: string,
  from: Date,
  to: Date,
  options: BirdeyePriceOptions = {}
): Promise<BirdeyeHistoricalPricePoint[] | null> {
  const baseUrl = (options.baseUrl ?? process.env.BIRDEYE_API_URL ?? DEFAULT_BIRDEYE_API_URL).replace(/\/$/, '');
  const body = await fetchBirdeyeJson(mint, createHistoryUrl(baseUrl, mint, from, to), options);
  if (!body) {
    return null;
  }

  const points = extractBirdeyePricePoints(body).map((point) => ({
    mint,
    timestamp: point.timestamp,
    priceUsd: point.priceUsd,
    provider: 'birdeye' as const,
  }));
  if (points.length === 0) {
    console.warn(`Birdeye historical price missing for ${mint}`);
  }
  return points;
}
