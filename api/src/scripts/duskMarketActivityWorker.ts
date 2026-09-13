import pool from '../config/database';
import { projectFinalizedMarketActivity } from '../services/duskMarketActivity';

async function main() {
  if (!process.env.DATABASE_URL?.trim()) throw new Error('DATABASE_URL is required');
  const intervalMs = Number(process.env.DUSK_MARKET_ACTIVITY_INTERVAL_MS ?? 10_000);
  if (!Number.isSafeInteger(intervalMs) || intervalMs<1000) throw new Error('Invalid DUSK_MARKET_ACTIVITY_INTERVAL_MS');
  let stopped = false;
  process.once('SIGINT',() => { stopped = true; });
  process.once('SIGTERM',() => { stopped = true; });
  do {
    let count: number;
    do {
      count = await projectFinalizedMarketActivity();
      if (count) console.log('Projected finalized Dusk activity',{ count });
    } while (count === 500 && !stopped);
    if (process.argv.includes('--once')) break;
    for (let elapsed=0;elapsed<intervalMs && !stopped;elapsed+=500)
      await new Promise((resolve) => setTimeout(resolve,Math.min(500,intervalMs-elapsed)));
  } while (!stopped);
}
main().catch(() => {
  console.error('Dusk market activity projection failed; original source observations retained');
  process.exitCode = 1;
}).finally(() => pool.end());
