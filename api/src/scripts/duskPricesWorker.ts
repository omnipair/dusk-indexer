import { runDevnetMockPublisher } from '../services/duskMockOraclePublisher';
import pool from '../config/database';
import { drainOnEvents } from '../services/duskEventDrain';
import { refreshExternalPrices } from '../services/duskObservedPrices';

async function main() {
  if (!process.env.DATABASE_URL?.trim()) throw new Error('DATABASE_URL is required');
  // Program prices come from post-swap snapshots at read time. This worker
  // only records provider quotes for referenced mints when events land.
  const abort = new AbortController();
  const publisher = runDevnetMockPublisher(abort.signal);
  // Report configuration failure immediately, without exposing key material.
  void publisher.catch(() => { console.error('Devnet mock publisher configuration failed'); abort.abort(); });
  try { await drainOnEvents(pool,'Dusk provider prices',async () => {
    const stored = await refreshExternalPrices();
    if (stored) console.log('Recorded Dusk provider prices',{ count: stored });
  }); } finally { abort.abort(); await publisher; }
}
main().catch(() => { console.error('Dusk provider price refresh failed'); process.exitCode = 1; }).finally(() => pool.end());
