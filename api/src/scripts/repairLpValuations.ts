import dotenv from 'dotenv';
import pool from '../config/database';
import { repairLpEarningsValuations } from '../services/lpValuationRepairService';

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
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid date for ${name}: ${value}`);
  }
  return date;
}

function readNumberArg(name: string): number | undefined {
  const value = readArg(name);
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid positive number for ${name}: ${value}`);
  }
  return parsed;
}

async function main(): Promise<void> {
  const dryRun = hasFlag('--dry-run');
  const pair = readArg('--pair');
  const from = readDateArg('--from');
  const to = readDateArg('--to');
  const lookbackHours = readNumberArg('--lookback-hours');
  const rebuildSnapshots = !hasFlag('--no-rebuild-snapshots');

  console.log('=== Omnipair LP Valuation Repair ===');
  if (dryRun) console.log('Dry run enabled');
  if (pair) console.log(`Pair filter: ${pair}`);
  if (from) console.log(`From: ${from.toISOString()}`);
  if (to) console.log(`To: ${to.toISOString()}`);
  if (lookbackHours) console.log(`Lookback: ${lookbackHours}h`);
  if (!rebuildSnapshots) console.log('Portfolio snapshot rebuild disabled');

  const result = await repairLpEarningsValuations(pool, {
    dryRun,
    pair,
    from,
    to,
    lookbackHours,
    rebuildSnapshots,
  });

  console.log('LP valuation repair complete:', JSON.stringify(result, null, 2));
}

main()
  .catch((error) => {
    console.error('LP valuation repair failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
