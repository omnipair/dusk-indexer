import { readFileSync } from 'node:fs';
import { Connection, Keypair } from '@solana/web3.js';
import pool from '../config/database';
import { duskApiConfig } from '../config/duskProtocol';
import { crankStaleMarkets } from '../services/duskMarketCrank';

/** The permissionless market crank, as the v1 cranker sends update_pair: every
 * interval, markets whose latest MarketObserved is older than the stale bound
 * get one `observe_market`. It dry-runs unless DUSK_CRANK_LIVE=true and a
 * fee-payer keypair file is mounted at DUSK_CRANK_KEYPAIR_PATH. */
async function main() {
  if (!process.env.DATABASE_URL?.trim()) throw new Error('DATABASE_URL is required');
  const integer = (name: string,fallback: number,minimum: number) => {
    const value = Number(process.env[name] ?? fallback);
    if (!Number.isSafeInteger(value) || value<minimum) throw new Error(`Invalid ${name}`);
    return value;
  };
  const intervalMs = integer('DUSK_CRANK_INTERVAL_MS',30_000,1_000);
  const staleSeconds = integer('DUSK_CRANK_STALE_SECONDS',60,1);
  const limit = integer('DUSK_CRANK_MAX_MARKETS',20,1);
  const live = process.env.DUSK_CRANK_LIVE === 'true';
  let payer: Keypair | undefined,connection: Connection | undefined;
  if (live) {
    const path = process.env.DUSK_CRANK_KEYPAIR_PATH?.trim();
    if (!path) throw new Error('DUSK_CRANK_LIVE requires DUSK_CRANK_KEYPAIR_PATH');
    payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path,'utf8')) as number[]));
    connection = new Connection(duskApiConfig().rpcUrl,'confirmed');
  }
  console.log('Dusk market crank',{ live,intervalMs,staleSeconds,limit,payer: payer?.publicKey.toBase58() ?? null });
  let stopped = false;
  process.once('SIGINT',() => { stopped = true; });
  process.once('SIGTERM',() => { stopped = true; });
  do {
    for (const result of await crankStaleMarkets({ pool,staleSeconds,limit,connection,payer })) {
      if (result.error) console.warn('observe_market failed',result);
      else console.log(live ? 'observe_market sent' : 'observe_market due (dry run)',result);
    }
    if (process.argv.includes('--once')) break;
    for (let elapsed = 0; elapsed<intervalMs && !stopped; elapsed += 500)
      await new Promise((resolve) => setTimeout(resolve,Math.min(500,intervalMs-elapsed)));
  } while (!stopped);
}
main().catch((error: unknown) => {
  console.error('Dusk market crank failed',{ message: error instanceof Error ? error.message : 'unknown' });
  process.exitCode = 1;
}).finally(() => pool.end());
