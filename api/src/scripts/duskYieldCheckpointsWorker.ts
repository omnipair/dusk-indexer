import pool from '../config/database';
import { captureDuskYieldCheckpoints, replayYieldCheckpoints } from '../services/duskYieldCheckpoints';

let phase: 'startup' | 'replay' | 'capture' = 'startup';

async function main() {
  if (!process.env.DATABASE_URL?.trim()) throw new Error('DATABASE_URL is required');
  const intervalMs = Number(process.env.DUSK_YIELD_CHECKPOINT_INTERVAL_MS ?? 60_000);
  if (!Number.isSafeInteger(intervalMs) || intervalMs<1000) throw new Error('Invalid checkpoint interval');
  let stopped = false;
  process.once('SIGINT',() => { stopped = true; });
  process.once('SIGTERM',() => { stopped = true; });
  do {
    phase = 'replay';
    let projected: number;
    do {
      projected = await replayYieldCheckpoints();
      if (projected>0) console.log('Replayed finalized Dusk yield checkpoints',{ count: projected });
    } while (projected === 500 && !stopped);
    if (stopped || process.argv.includes('--replay-only')) break;
    phase = 'capture';
    console.log('Captured finalized Dusk yield checkpoints',await captureDuskYieldCheckpoints());
    if (process.argv.includes('--once')) break;
    for (let elapsed = 0; elapsed<intervalMs && !stopped; elapsed+=500)
      await new Promise((resolve) => setTimeout(resolve,Math.min(500,intervalMs-elapsed)));
  } while (!stopped);
}
main().catch((error: unknown) => {
  // RPC/database messages may contain credentials. Match the claim worker's
  // bounded error-code logging while exposing which phase actually failed.
  const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && /^[A-Z0-9_]{1,32}$/.test(error.code)
    ? error.code : 'CHECKPOINT_FAILED';
  console.error('Yield checkpoint worker failed; retained observations require replay or investigation', { phase,code });
  process.exitCode = 1;
}).finally(() => pool.end());
