import dotenv from 'dotenv';
import pool from '../config/database';
import {
  backfillHistoricalTokenPricesRange,
  createHistoricalTokenPriceCache,
} from '../services/tokenPriceSnapshotService';
import { HOUR_MS, floorToHour } from '../utils/portfolioMath';

dotenv.config();

interface MintRow {
  mint: string;
}

function readArg(name: string): string | undefined {
  const args = process.argv.slice(2);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.slice(2).includes(name);
}

function readNumberArg(name: string, fallback: number): number {
  const value = readArg(name);
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid positive number for ${name}: ${value}`);
  }
  return parsed;
}

function readDateArg(name: string): Date | undefined {
  const value = readArg(name);
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid date for ${name}: ${value}`);
  }
  return date;
}

async function loadMints(pair?: string): Promise<string[]> {
  const params: any[] = [];
  let where = '';
  if (pair) {
    params.push(pair);
    where = 'WHERE pair_address = $1';
  }

  const result = await pool.query<MintRow>(
    `
      SELECT DISTINCT mint
      FROM (
        SELECT token0 AS mint FROM pools ${where}
        UNION
        SELECT token1 AS mint FROM pools ${where}
      ) mints
      WHERE mint IS NOT NULL
      ORDER BY mint
    `,
    params
  );

  return result.rows.map((row) => row.mint);
}

async function defaultStart(): Promise<Date> {
  const result = await pool.query<{ start_time: Date | string | null }>(
    `
      SELECT MIN(first_seen) AS start_time
      FROM (
        SELECT MIN("timestamp") AS first_seen FROM swaps
        UNION ALL
        SELECT MIN("timestamp") AS first_seen FROM update_pair_events
        UNION ALL
        SELECT MIN("timestamp") AS first_seen FROM user_lp_position_updated_events
        UNION ALL
        SELECT MIN(event_timestamp) AS first_seen FROM user_position_updated_events
      ) starts
    `
  );
  const start = result.rows[0]?.start_time;
  return start ? floorToHour(new Date(start)) : floorToHour(new Date());
}

function addHours(date: Date, hours: number): Date {
  return new Date(date.getTime() + hours * HOUR_MS);
}

function minDate(a: Date, b: Date): Date {
  return a <= b ? a : b;
}

function maxDate(a: Date, b: Date): Date {
  return a >= b ? a : b;
}

async function main(): Promise<void> {
  const dryRun = hasFlag('--dry-run');
  const pair = readArg('--pair');
  const from = floorToHour(readDateArg('--from') ?? await defaultStart());
  const to = floorToHour(readDateArg('--to') ?? new Date());
  const maxBuckets = readArg('--max-buckets') ? readNumberArg('--max-buckets', Number.POSITIVE_INFINITY) : Number.POSITIVE_INFINITY;
  const chunkHours = Math.min(readNumberArg('--chunk-hours', 168), Math.max(maxBuckets, 1));
  const reverse = hasFlag('--reverse');
  const refreshMissing = hasFlag('--refresh-missing');
  const persistMissing = !hasFlag('--no-persist-missing');
  const delayMs = readArg('--delay-ms') ? readNumberArg('--delay-ms', 0) : 0;
  const mints = await loadMints(pair);
  const cache = createHistoricalTokenPriceCache();

  console.log('=== Omnipair Token Price Backfill ===');
  if (dryRun) console.log('Dry run enabled');
  if (reverse) console.log('Reverse mode enabled');
  if (refreshMissing) console.log('Refreshing existing missing price markers');
  console.log(`Mints: ${mints.length}`);
  console.log(`Range: ${from.toISOString()} -> ${to.toISOString()}`);
  console.log(`Chunk size: ${chunkHours} hourly buckets`);
  if (delayMs > 0) console.log(`Birdeye delay: ${delayMs}ms between mint range fetches`);

  let processedBuckets = 0;
  let written = 0;
  let historicalWritten = 0;
  let estimatedWritten = 0;
  let missingWritten = 0;
  let fetchedMints = 0;
  let failedMints = 0;
  let skippedExisting = 0;
  let chunkStart = reverse
    ? floorToHour(new Date(Math.min(to.getTime(), from.getTime() + (maxBuckets - 1) * HOUR_MS)))
    : new Date(from);

  while (
    processedBuckets < maxBuckets
    && (reverse ? chunkStart >= from : chunkStart <= to)
  ) {
    const remainingBuckets = maxBuckets - processedBuckets;
    const currentChunkHours = Math.min(chunkHours, remainingBuckets);
    const chunkFrom = reverse
      ? maxDate(from, addHours(chunkStart, -(currentChunkHours - 1)))
      : chunkStart;
    const chunkTo = reverse
      ? chunkStart
      : minDate(to, addHours(chunkStart, currentChunkHours - 1));

    const result = await backfillHistoricalTokenPricesRange(pool, mints, chunkFrom, chunkTo, {
      dryRun,
      allowCurrentFallback: true,
      persistMissing,
      refreshMissing,
      cache,
      delayMs,
    });

    processedBuckets += result.buckets;
    written += result.written;
    historicalWritten += result.historicalWritten;
    estimatedWritten += result.estimatedWritten;
    missingWritten += result.missingWritten;
    fetchedMints += result.fetchedMints;
    failedMints += result.failedMints;
    skippedExisting += result.skippedExisting;
    console.log(
      `Processed ${processedBuckets} buckets through ${reverse ? chunkFrom.toISOString() : chunkTo.toISOString()} ` +
      `(written=${written}, historical=${historicalWritten}, estimated=${estimatedWritten}, missing=${missingWritten}, fetchedMints=${fetchedMints}, failedMints=${failedMints})`
    );

    chunkStart = reverse
      ? addHours(chunkFrom, -1)
      : addHours(chunkTo, 1);
  }

  console.log('Backfill complete:', {
    buckets: processedBuckets,
    written,
    historicalWritten,
    estimatedWritten,
    missingWritten,
    fetchedMints,
    failedMints,
    skippedExisting,
    dryRun,
  });
}

main()
  .catch((error) => {
    console.error('Token price backfill failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
