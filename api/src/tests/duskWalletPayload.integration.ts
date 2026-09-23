/** Requires the disposable live-snapshot database; no chain reads. */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pool from '../config/database';
import {
  currentPayload,
  PayloadEnvelope,
  payloadDependencies,
} from '../services/duskPayloads';
import { sharedDuskSnapshot } from '../services/duskSharedSnapshot';
import { displayKey } from './duskDisplayStateFixtures';
import type { DuskDeploymentEnvelope } from '../services/duskDeploymentService';
if (
  !process.env.DATABASE_URL ||
  process.env.DUSK_ALLOW_DISPOSABLE_DB_TESTS !== 'true'
)
  throw new Error('Disposable database opt-in required');
after(() => pool.end());
test('wallet payload consumers across connections share whole revisions, preserving age on failed capture', async () => {
  const identity = randomUUID().replace(/-/g, '').repeat(2);
  const deployment = {
    deploymentIdentitySha256: identity,
    sourceSlot: 100,
  } as DuskDeploymentEnvelope;
  const selection = {
    kind: 'wallet' as const,
    owner: displayKey(90).toBase58(),
  };
  const key = `payload.v1:${identity}:${JSON.stringify(selection)}`;
  const observedAt = Date.now();
  const value: PayloadEnvelope = {
    success: true,
    deployment,
    data: {
      schemaVersion: 'dusk-payload.v1',
      selection,
      revision: randomUUID(),
      observedAt,
      expiresAt: observedAt + 15000,
      sourceSlot: 100,
      payload: {
        positions: [1, 2, 3, 4, 5, 6],
        pnls: [10, 20, 30, 40, 50, 60],
      },
    },
  };
  let captures = 0,
    fail = false;
  const deps: typeof payloadDependencies = {
    envelope: async () => deployment,
    shared: sharedDuskSnapshot,
    capture: async () => {
      captures++;
      if (fail) throw new Error('capture unavailable');
      return value;
    },
  };
  try {
    const first = await currentPayload(selection, deps);
    const copies = await Promise.all(
      Array.from({ length: 20 }, () => currentPayload(selection, deps)),
    );
    assert.equal(captures, 1);
    copies.forEach((copy) => assert.deepEqual(copy, first));
    await pool.query(
      "UPDATE dusk_ingestion.live_snapshots SET refresh_after=clock_timestamp()-interval '1 second' WHERE snapshot_key=$1",
      [key],
    );
    fail = true;
    await assert.rejects(
      currentPayload(selection, deps),
      /capture unavailable/,
    );
    assert.deepEqual(await currentPayload(selection, deps), first);
    assert.equal(captures, 2);
    await pool.query(
      "UPDATE dusk_ingestion.live_snapshots SET payload=jsonb_set(payload,'{data,expiresAt}','0') WHERE snapshot_key=$1",
      [key],
    );
    assert.equal(await currentPayload(selection, deps), null);
  } finally {
    await pool.query(
      'DELETE FROM dusk_ingestion.live_snapshots WHERE snapshot_key=$1',
      [key],
    );
  }
});
