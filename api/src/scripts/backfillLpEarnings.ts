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

async function main(): Promise<void> {
  const source = readArg('--source') as LpEarningSource | undefined;
  const pair = readArg('--pair');
  const limit = readArg('--limit') ? Number(readArg('--limit')) : undefined;
  const maxEvents = readArg('--max-events') ? Number(readArg('--max-events')) : undefined;
  const dryRun = hasFlag('--dry-run');

  console.log('=== Omnipair LP Earnings Backfill ===');
  if (dryRun) console.log('Dry run enabled');
  if (pair) console.log(`Pair filter: ${pair}`);
  if (source) console.log(`Source filter: ${source}`);

  const result = await backfillLpEarnings(pool, {
    dryRun,
    pair,
    source,
    limit,
    maxEvents,
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
