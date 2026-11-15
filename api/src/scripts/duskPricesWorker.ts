import { runDevnetMockPublisher } from '../services/duskMockOraclePublisher';
import pool from '../config/database';
import { coalescedDrain, drainOnEvents } from '../services/duskEventDrain';
import { EXTERNAL_PRICE_REFRESH_MS, refreshExternalPrices } from '../services/duskObservedPrices';
import { portfolioPriceRepairWake } from '../services/duskPortfolioPriceRepairWorker';
import { isFatalPortfolioError } from '../services/duskPortfolioWorker';

async function main() {
  if (!process.env.DATABASE_URL?.trim()) throw new Error('DATABASE_URL is required');
  // Program prices come from post-swap snapshots at read time. This worker
  // records provider quotes for market assets on events and while idle.
  const abort = new AbortController();
  const publisher = runDevnetMockPublisher(abort.signal);
  // Report configuration failure immediately, without exposing key material.
  void publisher.catch(() => { console.error('Devnet mock publisher configuration failed'); abort.abort(); });
  const repair = portfolioPriceRepairWake();
  const refresh = coalescedDrain(async () => {
    const stored = await refreshExternalPrices();
    if (stored) console.log('Recorded Dusk provider prices',{ count: stored });
    await repair();
  });
  // USD display prices must stay fresh even when a market has no new trades.
  const timer = process.argv.includes('--once') ? null : setInterval(() => {
    void refresh.wake().catch(error => {
      if (isFatalPortfolioError(error)) abort.abort(error);
      else console.warn('Dusk provider price refresh failed; retrying on the next wake');
    });
  },EXTERNAL_PRICE_REFRESH_MS);
  try { await drainOnEvents(pool,'Dusk provider prices',() => refresh.wake(),abort.signal); }
  finally { if (timer) clearInterval(timer); abort.abort(); await publisher; }
}
main().catch(() => { console.error('Dusk provider price refresh failed'); process.exitCode = 1; }).finally(() => pool.end());
