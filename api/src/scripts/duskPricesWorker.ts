import pool from '../config/database';
import { captureDuskPrices, replayPriceCaptures } from '../services/duskPrices';

async function main() {
  if (!process.env.DATABASE_URL?.trim()) throw new Error('DATABASE_URL is required');
  const intervalMs = Number(process.env.DUSK_PRICE_INTERVAL_MS ?? 60_000);
  if (!Number.isSafeInteger(intervalMs) || intervalMs<1000) throw new Error('Invalid price capture interval');
  let stopped = false;
  process.once('SIGINT',() => { stopped = true; });
  process.once('SIGTERM',() => { stopped = true; });
  do {
    let replayed: number;
    do { replayed = await replayPriceCaptures(); if (replayed>0) console.log('Replayed Dusk price captures',{ count: replayed }); }
    while (replayed === 100 && !stopped);
    if (stopped || process.argv.includes('--replay-only')) break;
    console.log('Captured finalized Dusk price observations',await captureDuskPrices());
    if (process.argv.includes('--once')) break;
    for (let elapsed = 0; elapsed<intervalMs && !stopped; elapsed+=500)
      await new Promise((resolve) => setTimeout(resolve,Math.min(500,intervalMs-elapsed)));
  } while (!stopped);
}
main().catch(() => { console.error('Dusk price capture failed; saved sources retained for investigation'); process.exitCode = 1; }).finally(() => pool.end());
