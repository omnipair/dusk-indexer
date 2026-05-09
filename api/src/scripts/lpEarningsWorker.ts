import dotenv from 'dotenv';
import pool from '../config/database';
import { backfillLpEarnings } from '../services/lpEarningsBackfillService';

dotenv.config();

const LP_EARNINGS_INTERVAL_MS = parseInt(
  process.env.LP_EARNINGS_INTERVAL_MS || `${60 * 1000}`,
  10
);
const LP_EARNINGS_LIMIT = parseInt(process.env.LP_EARNINGS_LIMIT || '1000', 10);
const LP_EARNINGS_MAX_EVENTS = parseInt(
  process.env.LP_EARNINGS_MAX_EVENTS || '1000',
  10
);
const LP_EARNINGS_PROGRESS_EVERY = parseInt(
  process.env.LP_EARNINGS_PROGRESS_EVERY || '1000',
  10
);

let shuttingDown = false;
let inFlight = false;

async function runLpEarningsCatchup(): Promise<void> {
  if (inFlight) {
    console.log('Previous LP earnings catch-up is still in flight; skipping this tick');
    return;
  }

  inFlight = true;
  try {
    const result = await backfillLpEarnings(pool, {
      limit: LP_EARNINGS_LIMIT,
      maxEvents: LP_EARNINGS_MAX_EVENTS,
      progressEvery: LP_EARNINGS_PROGRESS_EVERY,
    });
    console.log('LP earnings catch-up complete:', result);
  } catch (error) {
    console.error('LP earnings catch-up failed:', error);
  } finally {
    inFlight = false;
  }
}

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log(`${signal} received, shutting down LP earnings worker`);
  await pool.end();
  process.exit(0);
}

async function main(): Promise<void> {
  console.log('=== Omnipair LP Earnings Worker ===');
  console.log(`Interval: ${LP_EARNINGS_INTERVAL_MS}ms`);
  console.log(`Limit per batch: ${LP_EARNINGS_LIMIT}`);
  console.log(`Max events per run: ${LP_EARNINGS_MAX_EVENTS}`);

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await runLpEarningsCatchup();
  setInterval(() => {
    void runLpEarningsCatchup();
  }, LP_EARNINGS_INTERVAL_MS);
}

main().catch(async (error) => {
  console.error('LP earnings worker failed:', error);
  await pool.end();
  process.exit(1);
});
