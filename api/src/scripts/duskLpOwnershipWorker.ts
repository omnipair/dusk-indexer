import pool from '../config/database';
import { captureDuskLpOwnership } from '../services/duskLpOwnership';

async function main() {
  if (!process.env.DATABASE_URL?.trim()) throw new Error('DATABASE_URL is required');
  const intervalMs = Number(process.env.DUSK_LP_SCAN_INTERVAL_MS ?? 30_000);
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1_000) throw new Error('DUSK_LP_SCAN_INTERVAL_MS must be at least 1000');
  let stopped = false;
  process.once('SIGINT', () => { stopped = true; });
  process.once('SIGTERM', () => { stopped = true; });
  do {
    try { console.log('Dusk LP ownership scan completed', await captureDuskLpOwnership()); }
    catch (error) {
      if (process.argv.includes('--once') || String(error).includes('FINALIZED_INVARIANT')) throw error;
      console.error('Dusk LP ownership scan failed; existing finalized snapshots retained', error);
    }
    if (process.argv.includes('--once')) break;
    for (let waited = 0; waited < intervalMs && !stopped; waited += 500)
      await new Promise((resolve) => setTimeout(resolve, Math.min(500, intervalMs-waited)));
  } while (!stopped);
}
main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => pool.end());
