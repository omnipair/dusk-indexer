import pool from '../config/database';
import { captureDuskPortfolioSnapshots, replayPortfolioCaptures } from '../services/duskPortfolioSnapshots';

async function main() {
  if (!process.env.DATABASE_URL?.trim()) throw new Error('DATABASE_URL is required');
  const interval = Number(process.env.DUSK_PORTFOLIO_INTERVAL_MS ?? 60_000);
  if (!Number.isSafeInteger(interval) || interval<1000) throw new Error('Invalid portfolio capture interval');
  let stopped = false;
  process.once('SIGINT',() => { stopped = true; });
  process.once('SIGTERM',() => { stopped = true; });
  do {
    let replayed: number;
    do { replayed = await replayPortfolioCaptures(); if (replayed) console.log('Replayed Dusk portfolio captures',{ count: replayed }); }
    while (replayed === 10 && !stopped);
    if (stopped || process.argv.includes('--replay-only')) break;
    console.log('Captured Dusk portfolio snapshots',await captureDuskPortfolioSnapshots());
    if (process.argv.includes('--once')) break;
    for (let elapsed=0; elapsed<interval && !stopped; elapsed+=500)
      await new Promise((resolve) => setTimeout(resolve,Math.min(500,interval-elapsed)));
  } while (!stopped);
}
main().catch(() => { console.error('Dusk portfolio capture failed; inspect discovery freshness and saved evidence'); process.exitCode=1; }).finally(() => pool.end());
