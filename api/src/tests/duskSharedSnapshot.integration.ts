/** Run with a dedicated disposable DATABASE_URL; creates only the live snapshot table. */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pool from '../config/database';
import { sharedDuskSnapshot } from '../services/duskSharedSnapshot';
if (!process.env.DATABASE_URL)
  throw new Error('Disposable DATABASE_URL required');
after(() => pool.end());
const identity = 'a'.repeat(64);
test('separate connections share one computation and a stored immutable snapshot', async () => {
  const key = `test:${randomUUID()}`,
    payload = { revision: randomUUID(), observedAt: 123, expiresAt: 456 };
  let calls = 0,
    release!: () => void,
    started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const compute = async () => {
    calls++;
    started();
    await held;
    return payload;
  };
  const request = () =>
    sharedDuskSnapshot({ key, identity, intervalMs: 1000, compute });
  const first = request();
  await entered;
  const concurrent = await Promise.all(Array.from({ length: 30 }, request));
  assert.ok(concurrent.every((value) => value === null));
  assert.equal(calls, 1);
  release();
  assert.deepEqual(await first, payload);
  const readers = await Promise.all(Array.from({ length: 30 }, request));
  readers.forEach((value) => assert.deepEqual(value, payload));
  assert.equal(calls, 1);
  await pool.query(
    "UPDATE dusk_ingestion.live_snapshots SET refresh_after=clock_timestamp()-interval '1 second' WHERE snapshot_key=$1",
    [key],
  );
  await request();
  assert.equal(calls, 2);
  await pool.query(
    'DELETE FROM dusk_ingestion.live_snapshots WHERE snapshot_key=$1',
    [key],
  );
});
test('failed computations share a cooldown and cannot renew old capture timestamps', async () => {
  const key = `test:${randomUUID()}`;
  let calls = 0;
  const options = {
    key,
    identity,
    intervalMs: 1000,
    compute: async () => {
      calls++;
      throw new Error('RPC unavailable');
    },
  };
  await assert.rejects(sharedDuskSnapshot(options), /RPC unavailable/);
  assert.equal(await sharedDuskSnapshot(options), null);
  assert.equal(calls, 1);
  await pool.query(
    'DELETE FROM dusk_ingestion.live_snapshots WHERE snapshot_key=$1',
    [key],
  );
});
