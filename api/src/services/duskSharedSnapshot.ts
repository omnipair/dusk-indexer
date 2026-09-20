import type { Pool } from 'pg';
import pool from '../config/database';

/** Cross-process single flight. Transaction-scoped locks release on crashes;
 * replica clocks do not decide cadence. Failed attempts also share a cooldown.
 * Snapshot timestamps belong to capture, never to delivery/cache lookup.
 */
export async function sharedDuskSnapshot<T>(
  options: {
    key: string;
    identity: string;
    intervalMs: number;
    compute(): Promise<T>;
  },
  database: Pick<Pool, 'connect'> = pool,
): Promise<T | null> {
  if (
    !/^[0-9a-f]{64}$/.test(options.identity) ||
    options.key.length > 512 ||
    !Number.isSafeInteger(options.intervalMs) ||
    options.intervalMs < 1000 ||
    options.intervalMs > 60_000
  )
    throw new Error('Invalid shared snapshot selection');
  const client = await database.connect();
  try {
    await client.query('BEGIN');
    const lock = await client.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired',
      [`live-snapshot:${options.identity}:${options.key}`],
    );
    const current = (
      await client.query<{ payload: T | null; due: boolean }>(
        `SELECT payload,refresh_after<=clock_timestamp() AS due FROM dusk_ingestion.live_snapshots
       WHERE snapshot_key=$1 AND deployment_identity_sha256=$2`,
        [options.key, options.identity],
      )
    ).rows[0];
    if (!lock.rows[0].acquired || (current && !current.due)) {
      await client.query('COMMIT');
      return current?.payload ?? null;
    }
    let payload: T;
    try {
      payload = await options.compute();
    } catch (error) {
      // Preserve the original payload's expiry; no heartbeat can revive it.
      await client.query(
        `INSERT INTO dusk_ingestion.live_snapshots(snapshot_key,deployment_identity_sha256,payload,refresh_after)
        VALUES($1,$2,NULL,clock_timestamp()+$3*interval '1 millisecond')
        ON CONFLICT(snapshot_key) DO UPDATE SET refresh_after=EXCLUDED.refresh_after,updated_at=clock_timestamp()`,
        [options.key, options.identity, options.intervalMs],
      );
      await client.query('COMMIT');
      throw error;
    }
    await client.query(
      `INSERT INTO dusk_ingestion.live_snapshots(snapshot_key,deployment_identity_sha256,payload,refresh_after)
      VALUES($1,$2,$3::jsonb,clock_timestamp()+$4*interval '1 millisecond')
      ON CONFLICT(snapshot_key) DO UPDATE SET deployment_identity_sha256=EXCLUDED.deployment_identity_sha256,
        payload=EXCLUDED.payload,refresh_after=EXCLUDED.refresh_after,updated_at=clock_timestamp()`,
      [
        options.key,
        options.identity,
        JSON.stringify(payload),
        options.intervalMs,
      ],
    );
    await client.query('COMMIT');
    return payload;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
