import dotenv from 'dotenv';
import pool from '../config/database';
import { backfillLpEarnings } from '../services/lpEarningsBackfillService';
import { LpEarningSource } from '../utils/portfolioMath';

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

async function main(): Promise<void> {
  const source = readArg('--source') as LpEarningSource | undefined;
  const pair = readArg('--pair');
  const limit = readNumberArg('--limit');
  const maxEvents = readNumberArg('--max-events');
  const progressEvery = readNumberArg('--progress-every') ?? 1000;
  const dryRun = hasFlag('--dry-run');

  console.log('=== Omnipair LP Earnings Backfill ===');
  if (dryRun) console.log('Dry run enabled');
  if (pair) console.log(`Pair filter: ${pair}`);
  if (source) console.log(`Source filter: ${source}`);
  if (progressEvery) console.log(`Progress every ${progressEvery} source events`);

  const result = await backfillLpEarnings(pool, {
    dryRun,
    pair,
    source,
    limit,
    maxEvents,
    progressEvery,
  });

  console.log('Backfill complete:', result);
}

main()
  .catch((error) => {
    console.error('LP earnings backfill failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
