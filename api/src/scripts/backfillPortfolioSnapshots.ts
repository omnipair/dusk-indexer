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
  const limitUsers = readArg('--limit-users') ? Number(readArg('--limit-users')) : undefined;
  const maxBucketsPerUser = readArg('--max-buckets-per-user')
    ? Number(readArg('--max-buckets-per-user'))
    : undefined;

  console.log('=== Omnipair Portfolio Snapshot Backfill ===');
  if (dryRun) console.log('Dry run enabled');
  if (userAddress) console.log(`User filter: ${userAddress}`);

  const result = await backfillPortfolioSnapshots(pool, {
    dryRun,
    userAddress,
    limitUsers,
    maxBucketsPerUser,
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
