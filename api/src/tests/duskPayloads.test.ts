import test from 'node:test';
import assert from 'node:assert/strict';
import {
  currentPayload,
  payloadDependencies,
  payloadSelection,
  PayloadEnvelope,
} from '../services/duskPayloads';
import type { DuskDeploymentEnvelope } from '../services/duskDeploymentService';
const market = '11111111111111111111111111111111';
test('payload selections reject ambiguous fields, noncanonical markets and unbounded history', () => {
  assert.deepEqual(payloadSelection({ kind: 'markets' }), { kind: 'markets' });
  assert.deepEqual(payloadSelection({ kind: 'wallet', owner: market }), {
    kind: 'wallet',
    owner: market,
  });
  assert.deepEqual(payloadSelection({ kind: 'statistics', range: '24h' }), {
    kind: 'statistics',
    range: '24h',
  });
  assert.deepEqual(
    payloadSelection({
      kind: 'candles',
      market,
      side: 'base',
      resolutionSeconds: '900',
    }),
    { kind: 'candles', market, side: 'base', resolutionSeconds: 900 },
  );
  for (const input of [
    { kind: 'wallet', owner: market, market },
    { kind: 'wallet', owner: 'invalid' },
    { kind: 'statistics', range: '7d' },
    { kind: 'statistics', range: ['24h'] },
    { kind: 'statistics', range: 'all', owner: market },
    { kind: 'markets', market },
    { kind: 'trades', market, owner: market },
    { kind: 'trades', market: market + '1' },
    { kind: 'candles', market, side: 'base', resolutionSeconds: '1' },
    { kind: 'candles', market, side: 'base', resolutionSeconds: ['900'] },
  ])
    assert.throws(() => payloadSelection(input));
});
test('shared payload delivery preserves evidence age and checks identity after cache reads', async () => {
  const deployment = {
    deploymentIdentitySha256: 'a'.repeat(64),
    sourceSlot: 100,
  } as DuskDeploymentEnvelope;
  const selection = { kind: 'markets' as const };
  const value: PayloadEnvelope = {
    success: true,
    deployment,
    data: {
      schemaVersion: 'dusk-payload.v1',
      selection,
      revision: 'r1',
      sourceSlot: 100,
      observedAt: Date.now() - 1000,
      expiresAt: Date.now() + 10_000,
      payload: { markets: [] },
    },
  };
  let calls = 0,
    upgraded = false;
  const deps = {
    envelope: async (floor: number) => {
      assert.ok(floor === 0 || floor === 100);
      return {
        ...deployment,
        deploymentIdentitySha256:
          upgraded && ++calls > 1
            ? 'b'.repeat(64)
            : deployment.deploymentIdentitySha256,
      };
    },
    shared: async (options: { key: string; intervalMs: number }) => {
      assert.ok(options.key.includes(deployment.deploymentIdentitySha256));
      assert.equal(options.intervalMs, 2000);
      return value;
    },
    capture: async () => {
      throw new Error('Cache hit must not recapture');
    },
  } as unknown as typeof payloadDependencies;
  const delivered = await currentPayload(selection, deps);
  assert.equal(delivered?.data, value.data);
  assert.equal(delivered?.data.observedAt, value.data.observedAt);
  upgraded = true;
  await assert.rejects(currentPayload(selection, deps), /deployment changed/);
  upgraded = false;
  value.data.expiresAt = Date.now();
  assert.equal(await currentPayload(selection, deps), null);
});
