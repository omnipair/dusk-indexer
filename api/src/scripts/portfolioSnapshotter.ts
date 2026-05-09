import dotenv from 'dotenv';
import pool from '../config/database';
import { snapshotCurrentActiveUsers } from '../services/portfolioSnapshotService';

dotenv.config();

const SNAPSHOT_INTERVAL_MS = parseInt(
  process.env.PORTFOLIO_SNAPSHOT_INTERVAL_MS || `${60 * 60 * 1000}`,
  10
);

let shuttingDown = false;
let inFlight = false;

async function runSnapshot(): Promise<void> {
  if (inFlight) {
    console.log('Previous portfolio snapshot run is still in flight; skipping this tick');
    return;
  }

  inFlight = true;
  try {
    const result = await snapshotCurrentActiveUsers(pool, {
      limitUsers: process.env.PORTFOLIO_SNAPSHOT_LIMIT_USERS
        ? Number(process.env.PORTFOLIO_SNAPSHOT_LIMIT_USERS)
        : undefined,
    });
    console.log('Portfolio snapshot run complete:', result);
  } catch (error) {
    console.error('Portfolio snapshot run failed:', error);
  } finally {
    inFlight = false;
  }
}

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log(`${signal} received, shutting down portfolio snapshotter`);
  await pool.end();
  process.exit(0);
}

async function main(): Promise<void> {
  console.log('=== Omnipair Portfolio Snapshotter ===');
  console.log(`Interval: ${SNAPSHOT_INTERVAL_MS}ms`);

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await runSnapshot();
  setInterval(() => {
    void runSnapshot();
  }, SNAPSHOT_INTERVAL_MS);
}

main().catch(async (error) => {
  console.error('Portfolio snapshotter failed:', error);
  await pool.end();
  process.exit(1);
});
