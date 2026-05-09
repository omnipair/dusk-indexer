import { QueryResult, QueryResultRow } from 'pg';
import { fetchTokenPrices } from './jupiterPriceService';
import { fetchBirdeyeHistoricalPrice } from './birdeyePriceService';
import { PriceQuality, TokenPrice, floorToHour } from '../utils/portfolioMath';

interface Queryable {
  query<T extends QueryResultRow = any>(text: string, params?: any[]): Promise<QueryResult<T>>;
}

export interface HistoricalPriceOptions {
  dryRun?: boolean;
  provider?: 'birdeye';
  allowCurrentFallback?: boolean;
}

export interface StoredTokenPrice extends TokenPrice {
  mint: string;
  bucket: Date;
  provider: string;
}

interface TokenPriceRow {
  mint: string;
  bucket: Date | string;
  price_usd: string;
  decimals: number | null;
  provider: string;
  quality: PriceQuality;
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
    prices.set(row.mint, {
      mint: row.mint,
      bucket: new Date(row.bucket),
      provider: row.provider,
      priceUsd: Number(row.price_usd),
      decimals: row.decimals ?? 6,
      quality: row.quality,
    });
  }

  return prices;
}

export async function upsertTokenPriceSnapshot(
  db: Queryable,
  price: StoredTokenPrice
): Promise<void> {
  await db.query(
    `
      INSERT INTO token_price_snapshots (
        mint, bucket, price_usd, decimals, provider, quality, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, now())
      ON CONFLICT (mint, bucket, provider) DO UPDATE SET
        price_usd = EXCLUDED.price_usd,
        decimals = EXCLUDED.decimals,
        quality = EXCLUDED.quality,
        updated_at = now()
    `,
    [price.mint, price.bucket, price.priceUsd, price.decimals, price.provider, price.quality]
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
  const storedPrices = await loadStoredPrices(db, uniqueMints, bucket, provider);
  const missingMints = uniqueMints.filter((mint) => !storedPrices.has(mint));

  if (missingMints.length === 0) {
    return storedPrices;
  }

  const currentPrices = await getCurrentTokenPrices(missingMints);

  for (const mint of missingMints) {
    const currentPrice = currentPrices.get(mint);
    const decimals = currentPrice?.decimals ?? 6;
    const birdeyePrice = await fetchBirdeyeHistoricalPrice(mint, bucket);

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
    if (!options.dryRun && price.quality !== 'missing') {
      await upsertTokenPriceSnapshot(db, price);
    }
  }

  return storedPrices;
}
