import type { Pool, PoolClient } from 'pg';

/** Notified for every event the daemon writes (migration 045). */
export const DUSK_EVENT_INGESTED = 'dusk_event_ingested';

/** Runs `drain` once per wake, never concurrently. Wakes that land during a
 * pass collapse into one more pass. The returned promise settles with the
 * pass that covers the wake.
 */
export function coalescedDrain(drain: () => Promise<void>) {
  let pending = false, current: Promise<void> | undefined;
  const run = async () => {
    try { while (pending) { pending = false; await drain(); } }
    finally { current = undefined; }
  };
  return {
    wake(): Promise<void> {
      pending = true;
      current ??= run();
      return current;
    },
  };
}

/** Drain a projection now and after every streamed event, as the v1 volume
 * enricher reacts to each swap. Notifications sent while not listening are
 * lost, so every connection drains once it is listening. A failed pass
 * rejects; a lost connection reconnects. `--once` drains and returns.
 */
export function drainOnEvents(pool: Pool,label: string,drain: (stopping: () => boolean) => Promise<void>): Promise<void> {
  let stopped = false, finish: ((error?: unknown) => void) | undefined;
  const stopping = () => stopped;
  const stop = () => { if (finish) finish(); else stopped = true; };
  process.once('SIGINT',stop);
  process.once('SIGTERM',stop);
  if (process.argv.includes('--once')) return drain(stopping);
  const pass = coalescedDrain(() => drain(stopping));
  return new Promise((resolve,reject) => {
    // The listening connection is destroyed, never returned to the pool.
    let client: PoolClient | undefined, retry = 1_000;
    finish = (error?: unknown) => {
      if (stopped) return;
      stopped = true;
      client?.release(true);
      client = undefined;
      if (error === undefined) resolve(); else reject(error);
    };
    const failed = (error: unknown) => finish!(error ?? new Error(`${label}: drain failed`));
    const listen = async () => {
      if (stopped) return;
      let next: PoolClient;
      try {
        next = await pool.connect();
      } catch {
        if (stopped) return;
        console.warn(`${label}: database unavailable; retrying in ${retry / 1000}s`);
        setTimeout(listen,retry);
        retry = Math.min(retry*2,30_000);
        return;
      }
      if (stopped) { next.release(true); return; }
      const lost = () => {
        if (client !== next) return;
        client = undefined;
        next.release(true);
        if (stopped) return;
        console.warn(`${label}: event listener lost; reconnecting`);
        setTimeout(listen,retry);
      };
      next.on('error',lost);
      next.on('end',lost);
      next.on('notification',notice => {
        if (notice.channel === DUSK_EVENT_INGESTED) pass.wake().catch(failed);
      });
      client = next;
      try { await next.query(`LISTEN ${DUSK_EVENT_INGESTED}`); } catch { lost(); return; }
      retry = 1_000;
      pass.wake().catch(failed);
    };
    void listen();
  });
}
