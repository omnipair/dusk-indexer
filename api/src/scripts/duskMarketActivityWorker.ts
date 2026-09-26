import pool from '../config/database';
import { drainOnEvents } from '../services/duskEventDrain';
import { projectFinalizedMarketActivity } from '../services/duskMarketActivity';

async function main() {
  if (!process.env.DATABASE_URL?.trim()) throw new Error('DATABASE_URL is required');
  // Projects each streamed event as it lands, in bounded transactions.
  await drainOnEvents(pool,'Dusk market activity',async stopping => {
    let count: number;
    do {
      count = await projectFinalizedMarketActivity();
      if (count) console.log('Projected Dusk activity',{ count });
    } while (count === 500 && !stopping());
  });
}
main().catch(() => {
  console.error('Dusk market activity projection failed; original source observations retained');
  process.exitCode = 1;
}).finally(() => pool.end());
