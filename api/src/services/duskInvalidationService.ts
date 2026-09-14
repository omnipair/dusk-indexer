import type { PoolClient } from 'pg';
import pool from '../config/database';
import { cache } from '../utils/cache';
import { parseDuskReadChange, publishDuskReadChange } from './duskChangeBus';

/** Domain prefixes used by the preserved controllers and native readers. */
export const DUSK_INVALIDATION_PREFIXES = [
  'dusk:deployment_surface:', 'dusk:market_health:', 'pools:enriched:',
  'pool_info_', 'pair_state_', 'swaps:', 'liquidity:', 'lending:', 'activity:',
  'portfolio:', 'lp-earnings:', 'positions:', 'liq_positions:',
  'portfolio_snapshots:', 'portfolio_lp_earnings:', 'dusk:history:',
] as const;

export function invalidateDuskReadCaches(payload: string | undefined): void {
  const notice = parseDuskReadChange(payload);
  if (!notice) return;
  for (const prefix of DUSK_INVALIDATION_PREFIXES) cache.deleteByPrefix(prefix);
  publishDuskReadChange(notice);
}

let connection: PoolClient | undefined;
let reconnect: ReturnType<typeof setTimeout> | undefined;
let starting: Promise<void> | undefined;
let stopped = true;

export function duskInvalidationListenerReady(): boolean { return connection !== undefined && !stopped; }

async function connect(): Promise<void> {
  const client = await pool.connect();
  if (stopped) { client.release(); return; }
  let released = false;
  const disconnect = () => {
    if (released) return;
    released = true;
    if (connection === client) connection = undefined;
    client.release(true);
    publishDuskReadChange({ kind: 'unavailable', sourceSlot: 0 });
    scheduleReconnect();
  };
  client.on('error', disconnect);
  client.on('end', disconnect);
  client.on('notification', (notice) => {
    if (notice.channel !== 'dusk_events_updated' && notice.channel !== 'dusk_accounts_updated') return;
    try { invalidateDuskReadCaches(notice.payload); }
    catch { console.error('Invalid Dusk database notification'); }
  });
  try {
    await client.query('LISTEN dusk_events_updated; LISTEN dusk_accounts_updated');
    if (stopped || released) { disconnect(); return; }
    connection = client;
    // Notifications missed during downtime cannot be replayed.
    for (const prefix of DUSK_INVALIDATION_PREFIXES) cache.deleteByPrefix(prefix);
    publishDuskReadChange({ kind: 'resync', sourceSlot: 0 });
  } catch (error) { disconnect(); throw error; }
}

function scheduleReconnect(): void {
  if (stopped || reconnect) return;
  reconnect = setTimeout(() => {
    reconnect = undefined;
    starting = connect().catch(() => scheduleReconnect()).finally(() => { starting = undefined; });
  }, 2_000);
  reconnect.unref();
}

export async function startDuskInvalidationListener(): Promise<void> {
  stopped = false;
  if (connection) return;
  if (!starting) starting = connect().catch((error) => { scheduleReconnect(); throw error; }).finally(() => { starting = undefined; });
  await starting;
}

export async function stopDuskInvalidationListener(): Promise<void> {
  stopped = true;
  publishDuskReadChange({ kind: 'unavailable', sourceSlot: 0 });
  if (reconnect) clearTimeout(reconnect);
  reconnect = undefined;
  await starting?.catch(() => undefined);
  const client = connection;
  connection = undefined;
  if (client) {
    client.removeAllListeners('error');
    client.removeAllListeners('end');
    client.removeAllListeners('notification');
    client.release(true);
  }
}
