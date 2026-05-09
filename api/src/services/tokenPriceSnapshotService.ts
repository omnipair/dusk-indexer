import { QueryResult, QueryResultRow } from 'pg';
import { fetchTokenPrices } from './jupiterPriceService';
import {
  BirdeyeHistoricalPrice,
  BirdeyeHistoricalPricePoint,
  fetchBirdeyeHistoricalPrice,
  fetchBirdeyeHistoricalPriceRange,
} from './birdeyePriceService';
import { HOUR_MS, PriceQuality, TokenPrice, floorToHour } from '../utils/portfolioMath';

interface Queryable {
  query<T extends QueryResultRow = any>(text: string, params?: any[]): Promise<QueryResult<T>>;
}

export interface HistoricalPriceOptions {
  dryRun?: boolean;
  provider?: 'birdeye';
  allowCurrentFallback?: boolean;
  persistMissing?: boolean;
  refreshMissing?: boolean;
  cache?: HistoricalTokenPriceCache;
  currentPrices?: Map<string, TokenPrice>;
  getCurrentPrices?: (mints: string[]) => Promise<Map<string, TokenPrice>>;
  fetchHistoricalPrice?: (mint: string, bucket: Date) => Promise<BirdeyeHistoricalPrice | null>;
}

export interface HistoricalPriceRangeOptions extends HistoricalPriceOptions {
  fetchHistoricalPriceRange?: (
    mint: string,
    from: Date,
    to: Date
  ) => Promise<BirdeyeHistoricalPricePoint[] | null>;
  delayMs?: number;
}

export interface HistoricalPriceRangeBackfillResult {
  buckets: number;
  requestedMints: number;
  fetchedMints: number;
  failedMints: number;
  skippedExisting: number;
  written: number;
  historicalWritten: number;
  estimatedWritten: number;
  missingWritten: number;
  dryRun: boolean;
}

export interface StoredTokenPrice extends TokenPrice {
  mint: string;
  bucket: Date;
  provider: string;
}

export interface HistoricalTokenPriceCache {
  get(provider: string, mint: string, bucket: Date): StoredTokenPrice | undefined;
  set(price: StoredTokenPrice): void;
  size(): number;
}

interface TokenPriceRow {
  mint: string;
  bucket: Date | string;
  price_usd: string;
  decimals: number | null;
  provider: string;
  quality: PriceQuality;
}

class LruHistoricalTokenPriceCache implements HistoricalTokenPriceCache {
  private readonly entries = new Map<string, StoredTokenPrice>();

  constructor(private readonly maxEntries: number) {}

  get(provider: string, mint: string, bucket: Date): StoredTokenPrice | undefined {
    const key = priceCacheKey(provider, mint, bucket);
    const value = this.entries.get(key);
    if (!value) {
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(price: StoredTokenPrice): void {
    const key = priceCacheKey(price.provider, price.mint, price.bucket);
    if (this.entries.has(key)) {
      this.entries.delete(key);
    }
    this.entries.set(key, price);
    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (!oldestKey) {
        break;
      }
      this.entries.delete(oldestKey);
    }
  }

  size(): number {
    return this.entries.size;
  }
}

export function createHistoricalTokenPriceCache(maxEntries = 250_000): HistoricalTokenPriceCache {
  return new LruHistoricalTokenPriceCache(maxEntries);
}

function priceCacheKey(provider: string, mint: string, bucket: Date): string {
  return `${provider}:${mint}:${bucket.toISOString()}`;
}

function buildHourlyBuckets(from: Date, to: Date): Date[] {
  const buckets: Date[] = [];
  let bucket = floorToHour(from);
  const end = floorToHour(to);
  while (bucket <= end) {
    buckets.push(bucket);
    bucket = new Date(bucket.getTime() + HOUR_MS);
  }
  return buckets;
}

function mapRowToStoredPrice(row: TokenPriceRow): StoredTokenPrice {
  return {
    mint: row.mint,
    bucket: new Date(row.bucket),
    provider: row.provider,
    priceUsd: Number(row.price_usd),
    decimals: row.decimals ?? 6,
    quality: row.quality,
  };
}

async function loadStoredPrices(
  db: Queryable,
  mints: string[],
  bucket: Date,
  provider: string
): Promise<Map<string, StoredTokenPrice>> {
  if (mints.length === 0) {
    return new Map();
  }

  const result = await db.query<TokenPriceRow>(
    `
      SELECT mint, bucket, price_usd, decimals, provider, quality
      FROM token_price_snapshots
      WHERE mint = ANY($1::text[])
        AND bucket = $2
        AND provider = $3
    `,
    [mints, bucket, provider]
  );

  const prices = new Map<string, StoredTokenPrice>();
  for (const row of result.rows) {
    prices.set(row.mint, mapRowToStoredPrice(row));
  }

  return prices;
}

async function loadStoredPricesForRange(
  db: Queryable,
  mints: string[],
  from: Date,
  to: Date,
  provider: string,
  refreshMissing: boolean
): Promise<Map<string, StoredTokenPrice>> {
  if (mints.length === 0) {
    return new Map();
  }

  const result = await db.query<TokenPriceRow>(
    `
      SELECT mint, bucket, price_usd, decimals, provider, quality
      FROM token_price_snapshots
      WHERE mint = ANY($1::text[])
        AND bucket >= $2
        AND bucket <= $3
        AND provider = $4
    `,
    [mints, from, to, provider]
  );

  const prices = new Map<string, StoredTokenPrice>();
  for (const row of result.rows) {
    if (refreshMissing && row.quality === 'missing') {
      continue;
    }
    const price = mapRowToStoredPrice(row);
    prices.set(priceCacheKey(provider, price.mint, price.bucket), price);
  }

  return prices;
}

export async function upsertTokenPriceSnapshot(
  db: Queryable,
  price: StoredTokenPrice
): Promise<void> {
  await upsertTokenPriceSnapshots(db, [price]);
}

export async function upsertTokenPriceSnapshots(
  db: Queryable,
  prices: StoredTokenPrice[]
): Promise<void> {
  if (prices.length === 0) {
    return;
  }

  await db.query(
    `
      INSERT INTO token_price_snapshots (
        mint, bucket, price_usd, decimals, provider, quality
      )
      SELECT *
      FROM unnest(
        $1::text[],
        $2::timestamptz[],
        $3::numeric[],
        $4::integer[],
        $5::text[],
        $6::text[]
      ) AS prices(mint, bucket, price_usd, decimals, provider, quality)
      ON CONFLICT (mint, bucket, provider) DO UPDATE SET
        price_usd = EXCLUDED.price_usd,
        decimals = EXCLUDED.decimals,
        quality = EXCLUDED.quality,
        updated_at = now()
    `,
    [
      prices.map((price) => price.mint),
      prices.map((price) => price.bucket),
      prices.map((price) => price.priceUsd),
      prices.map((price) => price.decimals),
      prices.map((price) => price.provider),
      prices.map((price) => price.quality),
    ]
  );
}

export async function getCurrentTokenPrices(mints: string[]): Promise<Map<string, TokenPrice>> {
  const jupiterPrices = await fetchTokenPrices([...new Set(mints)]);
  const prices = new Map<string, TokenPrice>();

  for (const [mint, price] of jupiterPrices.entries()) {
    prices.set(mint, {
      priceUsd: price.price,
      decimals: price.decimals,
      quality: 'current',
    });
  }

  return prices;
}

export async function getHistoricalTokenPrices(
  db: Queryable,
  mints: string[],
  timestamp: Date,
  options: HistoricalPriceOptions = {}
): Promise<Map<string, StoredTokenPrice>> {
  const uniqueMints = [...new Set(mints.filter(Boolean))];
  const provider = options.provider ?? 'birdeye';
  const bucket = floorToHour(timestamp);
  const storedPrices = new Map<string, StoredTokenPrice>();
  const cacheMissMints: string[] = [];

  for (const mint of uniqueMints) {
    const cached = options.cache?.get(provider, mint, bucket);
    if (cached && !(options.refreshMissing && cached.quality === 'missing')) {
      storedPrices.set(mint, cached);
    } else {
      cacheMissMints.push(mint);
    }
  }

  const loadedPrices = await loadStoredPrices(db, cacheMissMints, bucket, provider);
  for (const [mint, price] of loadedPrices.entries()) {
    if (options.refreshMissing && price.quality === 'missing') {
      continue;
    }
    storedPrices.set(mint, price);
    options.cache?.set(price);
  }

  const missingMints = uniqueMints.filter((mint) => !storedPrices.has(mint));

  if (missingMints.length === 0) {
    return storedPrices;
  }

  const currentPrices = options.currentPrices
    ?? await (options.getCurrentPrices ?? getCurrentTokenPrices)(missingMints);
  const pricesToPersist: StoredTokenPrice[] = [];

  for (const mint of missingMints) {
    const currentPrice = currentPrices.get(mint);
    const decimals = currentPrice?.decimals ?? 6;
    const birdeyePrice = await (options.fetchHistoricalPrice ?? fetchBirdeyeHistoricalPrice)(mint, bucket);

    let price: StoredTokenPrice;
    if (birdeyePrice) {
      price = {
        mint,
        bucket,
        provider,
        priceUsd: birdeyePrice.priceUsd,
        decimals,
        quality: 'historical',
      };
    } else if (options.allowCurrentFallback && currentPrice) {
      price = {
        mint,
        bucket,
        provider,
        priceUsd: currentPrice.priceUsd,
        decimals,
        quality: 'estimated',
      };
    } else {
      price = {
        mint,
        bucket,
        provider,
        priceUsd: 0,
        decimals,
        quality: 'missing',
      };
    }

    storedPrices.set(mint, price);
    options.cache?.set(price);
    if (!options.dryRun && (price.quality !== 'missing' || options.persistMissing !== false)) {
      pricesToPersist.push(price);
    }
  }

  if (pricesToPersist.length > 0) {
    await upsertTokenPriceSnapshots(db, pricesToPersist);
  }

  return storedPrices;
}

export async function backfillHistoricalTokenPricesRange(
  db: Queryable,
  mints: string[],
  from: Date,
  to: Date,
  options: HistoricalPriceRangeOptions = {}
): Promise<HistoricalPriceRangeBackfillResult> {
  const uniqueMints = [...new Set(mints.filter(Boolean))];
  const provider = options.provider ?? 'birdeye';
  const buckets = buildHourlyBuckets(from, to);
  const cache = options.cache;
  const dryRun = Boolean(options.dryRun);
  const storedPrices = await loadStoredPricesForRange(
    db,
    uniqueMints,
    buckets[0] ?? floorToHour(from),
    buckets[buckets.length - 1] ?? floorToHour(to),
    provider,
    Boolean(options.refreshMissing)
  );
  const currentPrices = options.currentPrices
    ?? await (options.getCurrentPrices ?? getCurrentTokenPrices)(uniqueMints);
  const rangeFetcher = options.fetchHistoricalPriceRange ?? fetchBirdeyeHistoricalPriceRange;

  let fetchedMints = 0;
  let failedMints = 0;
  let skippedExisting = 0;
  let written = 0;
  let historicalWritten = 0;
  let estimatedWritten = 0;
  let missingWritten = 0;

  for (const mint of uniqueMints) {
    const missingBuckets = buckets.filter((bucket) => {
      const cached = cache?.get(provider, mint, bucket);
      if (cached && !(options.refreshMissing && cached.quality === 'missing')) {
        return false;
      }
      const stored = storedPrices.get(priceCacheKey(provider, mint, bucket));
      return !stored;
    });

    if (missingBuckets.length === 0) {
      skippedExisting += buckets.length;
      continue;
    }

    fetchedMints += 1;
    const points = await rangeFetcher(mint, missingBuckets[0], new Date(missingBuckets[missingBuckets.length - 1].getTime() + HOUR_MS));
    if (points === null) {
      failedMints += 1;
      if (options.delayMs) {
        await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      }
      continue;
    }
    const pointByBucket = new Map<string, BirdeyeHistoricalPricePoint>();
    for (const point of points) {
      pointByBucket.set(floorToHour(point.timestamp).toISOString(), point);
    }

    const currentPrice = currentPrices.get(mint);
    const decimals = currentPrice?.decimals ?? 6;
    const pricesToPersist: StoredTokenPrice[] = missingBuckets.map((bucket) => {
      const point = pointByBucket.get(bucket.toISOString());
      if (point) {
        return {
          mint,
          bucket,
          provider,
          priceUsd: point.priceUsd,
          decimals,
          quality: 'historical' as PriceQuality,
        };
      }
      if (options.allowCurrentFallback && currentPrice) {
        return {
          mint,
          bucket,
          provider,
          priceUsd: currentPrice.priceUsd,
          decimals,
          quality: 'estimated' as PriceQuality,
        };
      }
      return {
        mint,
        bucket,
        provider,
        priceUsd: 0,
        decimals,
        quality: 'missing' as PriceQuality,
      };
    });

    for (const price of pricesToPersist) {
      cache?.set(price);
      if (price.quality === 'historical') historicalWritten += 1;
      if (price.quality === 'estimated') estimatedWritten += 1;
      if (price.quality === 'missing') missingWritten += 1;
    }

    if (!dryRun) {
      const persistablePrices = pricesToPersist.filter(
        (price) => price.quality !== 'missing' || options.persistMissing !== false
      );
      await upsertTokenPriceSnapshots(db, persistablePrices);
      written += persistablePrices.length;
    }

    if (options.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    }
  }

  return {
    buckets: buckets.length,
    requestedMints: uniqueMints.length,
    fetchedMints,
    failedMints,
    skippedExisting,
    written,
    historicalWritten,
    estimatedWritten,
    missingWritten,
    dryRun,
  };
}
