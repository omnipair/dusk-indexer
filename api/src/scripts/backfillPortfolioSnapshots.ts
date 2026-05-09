import dotenv from 'dotenv';
import pool from '../config/database';
import { backfillPortfolioSnapshots } from '../services/portfolioSnapshotService';

dotenv.config();

function readArg(name: string): string | undefined {
  const args = process.argv.slice(2);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.slice(2).includes(name);
}

function readNumberArg(name: string): number | undefined {
  const value = readArg(name);
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid positive number for ${name}: ${value}`);
  }
  return parsed;
}

function readDateArg(name: string): Date | undefined {
  const value = readArg(name);
  if (!value) {
    return undefined;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid date for ${name}: ${value}`);
  }
  return date;
}

async function main(): Promise<void> {
  const dryRun = hasFlag('--dry-run');
  const userAddress = readArg('--user');
  const limitUsers = readNumberArg('--limit-users');
  const maxBucketsPerUser = readNumberArg('--max-buckets-per-user');
  const progressEveryBuckets = readNumberArg('--progress-every') ?? 5000;
  const concurrency = readNumberArg('--concurrency') ?? 1;
  const startAtFirstActivity = hasFlag('--start-at-first-activity');

  console.log('=== Omnipair Portfolio Snapshot Backfill ===');
  if (dryRun) console.log('Dry run enabled');
  if (userAddress) console.log(`User filter: ${userAddress}`);
  if (hasFlag('--skip-existing')) console.log('Skipping existing snapshot buckets');
  if (progressEveryBuckets) console.log(`Progress every ${progressEveryBuckets} computed buckets`);
  console.log(`Concurrency: ${concurrency}`);
  if (startAtFirstActivity) console.log('Starting each user at first activity hour');

  const result = await backfillPortfolioSnapshots(pool, {
    dryRun,
    userAddress,
    limitUsers,
    maxBucketsPerUser,
    skipExisting: hasFlag('--skip-existing'),
    progressEveryBuckets,
    concurrency,
    startAtFirstActivity,
    from: readDateArg('--from'),
    to: readDateArg('--to'),
  });

  console.log('Backfill complete:', result);
}

main()
  .catch((error) => {
    console.error('Portfolio snapshot backfill failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
    process.exit(process.exitCode ?? 0);
  });
