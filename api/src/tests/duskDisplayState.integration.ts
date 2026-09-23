/** Requires a dedicated disposable DATABASE_URL and the live-snapshot migration. */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pool from '../config/database';
import { currentDisplayState } from '../services/duskDisplayState';
import { sharedDuskSnapshot } from '../services/duskSharedSnapshot';
import type { DuskDeploymentEnvelope } from '../services/duskDeploymentService';

if (
  !process.env.DATABASE_URL ||
  process.env.DUSK_ALLOW_DISPOSABLE_DB_TESTS !== 'true'
)
  throw new Error('Disposable database opt-in required');
after(() => pool.end());

test('wallet API consumers share one persisted capture without renewing age or crossing identity', async () => {
  const identity = 'a'.repeat(64),
    key = `test-owner:${randomUUID()}`;
  const deployment = {
    deploymentIdentitySha256: identity,
    sourceSlot: 110,
  } as DuskDeploymentEnvelope;
  const deps = { envelope: async () => deployment, shared: sharedDuskSnapshot };
  const data = {
    sourceSlot: 100,
    observedAt: Date.now(),
    expiresAt: Date.now() + 15000,
    accounts: [],
  };
  let captures = 0;
  const capture = async () => {
    captures++;
    return data;
  };
  try {
    const first = await currentDisplayState(key, capture, deps);
    const repeated = await Promise.all(
      Array.from({ length: 20 }, () => currentDisplayState(key, capture, deps)),
    );
    assert.equal(captures, 1);
    for (const result of repeated) assert.deepEqual(result.data, first.data);
    const stored = await pool.query(
      'SELECT payload FROM dusk_ingestion.live_snapshots WHERE snapshot_key=$1',
      [`display.v1:${identity}:${key}`],
    );
    assert.equal(stored.rows[0].payload.data.observedAt, data.observedAt);
    // The cache cannot resurrect an old capture, even during its cooldown.
    await pool.query(
      "UPDATE dusk_ingestion.live_snapshots SET payload=jsonb_set(payload,'{data,expiresAt}','0') WHERE snapshot_key=$1",
      [`display.v1:${identity}:${key}`],
    );
    await assert.rejects(currentDisplayState(key, capture, deps), /expired/);
    assert.equal(captures, 1);
  } finally {
    await pool.query(
      'DELETE FROM dusk_ingestion.live_snapshots WHERE snapshot_key=$1',
      [`display.v1:${identity}:${key}`],
    );
  }
});
