import pool from '../config/database';
import { projectFinalizedYieldClaims } from '../services/duskYieldClaims';

async function main() {
  if (!process.env.DATABASE_URL?.trim()) throw new Error('DATABASE_URL is required');
  const intervalMs = Number(process.env.DUSK_YIELD_CLAIMS_INTERVAL_MS ?? 10_000);
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1_000) throw new Error('Invalid DUSK_YIELD_CLAIMS_INTERVAL_MS');
  let stopped = false;
  process.once('SIGINT', () => { stopped = true; });
  process.once('SIGTERM', () => { stopped = true; });
  do {
    // --once drains the available backlog, including historical replay, in
    // bounded transactions. Any malformed source stops the worker visibly.
    let projected: number;
    do {
      projected = await projectFinalizedYieldClaims();
      if (projected > 0) console.log('Projected finalized Dusk yield claims', { count: projected });
    } while (projected === 500 && !stopped);
    if (process.argv.includes('--once')) break;
    for (let elapsed = 0; elapsed < intervalMs && !stopped; elapsed += 500)
      await new Promise((resolve) => setTimeout(resolve, Math.min(500, intervalMs-elapsed)));
  } while (!stopped);
}
main().catch((error: unknown) => {
  // Do not dump connection objects or environment values into worker logs.
  const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && /^[A-Z0-9_]+$/.test(error.code)
    ? error.code : 'PROJECTION_FAILED';
  console.error('Dusk yield claim projection failed; finalized source rows retained for diagnosis', { code });
  process.exitCode = 1;
}).finally(() => pool.end());
