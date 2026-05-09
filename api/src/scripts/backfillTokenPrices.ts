import dotenv from 'dotenv';
import pool from '../config/database';
import { getHistoricalTokenPrices } from '../services/tokenPriceSnapshotService';
import { floorToHour } from '../utils/portfolioMath';

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

async function main(): Promise<void> {
  const dryRun = hasFlag('--dry-run');
  const pair = readArg('--pair');
  const from = floorToHour(readDateArg('--from') ?? await defaultStart());
  const to = floorToHour(readDateArg('--to') ?? new Date());
  const maxBuckets = readArg('--max-buckets') ? Number(readArg('--max-buckets')) : Number.POSITIVE_INFINITY;
  const mints = await loadMints(pair);

  console.log('=== Omnipair Token Price Backfill ===');
  if (dryRun) console.log('Dry run enabled');
  console.log(`Mints: ${mints.length}`);
  console.log(`Range: ${from.toISOString()} -> ${to.toISOString()}`);

  let bucket = new Date(from);
  let buckets = 0;
  while (bucket <= to && buckets < maxBuckets) {
    await getHistoricalTokenPrices(pool, mints, bucket, {
      dryRun,
      allowCurrentFallback: true,
    });
    buckets += 1;
    if (buckets % 24 === 0) {
      console.log(`Processed ${buckets} hourly buckets through ${bucket.toISOString()}`);
    }
    bucket = new Date(bucket.getTime() + 60 * 60 * 1000);
  }

  console.log(`Backfill complete: ${buckets} hourly buckets processed`);
}

main()
  .catch((error) => {
    console.error('Token price backfill failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
