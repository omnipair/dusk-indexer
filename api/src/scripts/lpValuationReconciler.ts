import dotenv from 'dotenv';
import pool from '../config/database';
import { repairLpEarningsValuations } from '../services/lpValuationRepairService';

dotenv.config();

const LP_VALUATION_RECONCILE_INTERVAL_MS = parseInt(
  process.env.LP_VALUATION_RECONCILE_INTERVAL_MS || `${60 * 60 * 1000}`,
  10
);
const LP_VALUATION_RECONCILE_LOOKBACK_HOURS = parseInt(
  process.env.LP_VALUATION_RECONCILE_LOOKBACK_HOURS || '72',
  10
);

let shuttingDown = false;
let inFlight = false;

async function runReconciliation(): Promise<void> {
  if (inFlight) {
    console.log('Previous LP valuation reconciliation is still in flight; skipping this tick');
    return;
  }

  inFlight = true;
  try {
    const result = await repairLpEarningsValuations(pool, {
      lookbackHours: LP_VALUATION_RECONCILE_LOOKBACK_HOURS,
    });
    console.log('LP valuation reconciliation complete:', result);
  } catch (error) {
    console.error('LP valuation reconciliation failed:', error);
  } finally {
    inFlight = false;
  }
}

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log(`${signal} received, shutting down LP valuation reconciler`);
  await pool.end();
  process.exit(0);
}

async function main(): Promise<void> {
  console.log('=== Omnipair LP Valuation Reconciler ===');
  console.log(`Interval: ${LP_VALUATION_RECONCILE_INTERVAL_MS}ms`);
  console.log(`Lookback: ${LP_VALUATION_RECONCILE_LOOKBACK_HOURS}h`);

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await runReconciliation();
  setInterval(() => {
    void runReconciliation();
  }, LP_VALUATION_RECONCILE_INTERVAL_MS);
}

main().catch(async (error) => {
  console.error('LP valuation reconciler failed:', error);
  await pool.end();
  process.exit(1);
});
