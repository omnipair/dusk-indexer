import pool from '../config/database';
import { drainOnEvents } from '../services/duskEventDrain';
import { projectFinalizedYieldClaims } from '../services/duskYieldClaims';

async function main() {
  if (!process.env.DATABASE_URL?.trim()) throw new Error('DATABASE_URL is required');
  // Projects each streamed claim as it lands. --once drains the available
  // backlog, including historical replay, in bounded transactions. Any
  // malformed source stops the worker visibly.
  await drainOnEvents(pool,'Dusk yield claims',async stopping => {
    let projected: number;
    do {
      projected = await projectFinalizedYieldClaims();
      if (projected > 0) console.log('Projected Dusk yield claims', { count: projected });
    } while (projected === 500 && !stopping());
  });
}
main().catch((error: unknown) => {
  // Do not dump connection objects or environment values into worker logs.
  const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && /^[A-Z0-9_]+$/.test(error.code)
    ? error.code : 'PROJECTION_FAILED';
  console.error('Dusk yield claim projection failed; source rows retained for diagnosis', { code });
  process.exitCode = 1;
}).finally(() => pool.end());
