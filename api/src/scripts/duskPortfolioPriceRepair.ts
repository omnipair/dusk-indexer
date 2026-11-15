import pool from '../config/database';
import { repairPortfolioPriceHistory } from '../services/duskPortfolioPriceRepair';
import { failureReason } from '../services/duskPortfolioWorker';

function numberOption(name: string,fallback: number) {
  const index = process.argv.indexOf(name);
  return index<0 ? fallback : Number(process.argv[index+1]);
}
async function main() {
  if (!process.env.DATABASE_URL?.trim()) throw new Error('DATABASE_URL is required');
  const dryRun = !process.argv.includes('--execute');
  console.log('Dusk historical portfolio price repair',await repairPortfolioPriceHistory({ dryRun,
    limit: numberOption('--limit',100),maxRequests: numberOption('--max-requests',4) }));
}
main().catch(error => {
  console.error('Dusk historical portfolio price repair failed',{ reason: failureReason(error) });
  process.exitCode = 1;
}).finally(() => pool.end());
