import pool from '../config/database';
import { captureDuskPortfolioSnapshots, replayPortfolioCaptures } from '../services/duskPortfolioSnapshots';
import { failureReason, runPortfolioCaptures } from '../services/duskPortfolioWorker';

async function main() {
  if (!process.env.DATABASE_URL?.trim()) throw new Error('DATABASE_URL is required');
  const interval = Number(process.env.DUSK_PORTFOLIO_INTERVAL_MS ?? 60_000);
  if (!Number.isSafeInteger(interval) || interval<1000) throw new Error('Invalid portfolio capture interval');
  let stopped = false;
  process.once('SIGINT',() => { stopped = true; });
  process.once('SIGTERM',() => { stopped = true; });
  await runPortfolioCaptures({ replay: replayPortfolioCaptures,capture: () => captureDuskPortfolioSnapshots(),intervalMs: interval,
    once: process.argv.includes('--once'),replayOnly: process.argv.includes('--replay-only'),stopped: () => stopped });
}
main().catch((error: unknown) => {
  console.error('Dusk portfolio capture failed; inspect discovery freshness and saved evidence',{ reason: failureReason(error) });
  process.exitCode=1;
}).finally(() => pool.end());
