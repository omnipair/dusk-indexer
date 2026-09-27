import pool from '../config/database';
import { drainOnEvents } from '../services/duskEventDrain';
import { refreshExternalPrices } from '../services/duskObservedPrices';

async function main() {
  if (!process.env.DATABASE_URL?.trim()) throw new Error('DATABASE_URL is required');
  // Program prices come from post-swap snapshots at read time. This worker
  // only records provider quotes for referenced mints when events land.
  await drainOnEvents(pool,'Dusk provider prices',async () => {
    const stored = await refreshExternalPrices();
    if (stored) console.log('Recorded Dusk provider prices',{ count: stored });
  });
}
main().catch(() => { console.error('Dusk provider price refresh failed'); process.exitCode = 1; }).finally(() => pool.end());
