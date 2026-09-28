import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { Connection } from '@solana/web3.js';
import { deploymentEnvelope, observedDeploymentEnvelope } from '../services/duskDeploymentService';
import { loadPinnedProtocol } from '../config/duskProtocol';
import type { DuskPinnedProgram } from '../config/duskProtocol';

const protocol = require('../config/duskProtocol') as typeof import('../config/duskProtocol');
const observation = require('../services/duskProgramObservation') as typeof import('../services/duskProgramObservation');
const coverage = require('../services/duskHistoryCoverage') as typeof import('../services/duskHistoryCoverage');

// The service builds its loader observer once per process, so every test
// shares this log of observed floors.
const observedFloors: number[] = [];

function chain(context: test.TestContext) {
  const pinned = loadPinnedProtocol(), rpc = { slots: [] as number[], headers: observedFloors.length };
  context.mock.method(protocol, 'duskApiConfig', () => ({ network: 'devnet', rpcUrl: 'http://localhost:1', buildRevision: 'test', envelopeCacheTtlMs: 0 }));
  context.mock.method(Connection.prototype, 'getGenesisHash', async () => pinned.genesisHash);
  context.mock.method(observation, 'createDuskProgramObserver', () => async (pins: readonly DuskPinnedProgram[], floor: number) => {
    observedFloors.push(floor);
    return pins.map(pin => ({ programDataAddress: pin.deployment.programData, programDataSlot: String(pin.deployment.deploySlot), upgradeAuthority: pin.deployment.upgradeAuthority, binarySha256: pin.binarySha256, sourceSlot: floor }));
  });
  return rpc;
}

test('database reads take the live stream\'s envelope without a chain read', async (context) => {
  const rpc = chain(context);
  context.mock.method(Connection.prototype, 'getSlot', async (options: { minContextSlot: number }) => { rpc.slots.push(options.minContextSlot); return options.minContextSlot; });
  context.mock.method(coverage, 'readStreamedDeployment', async () => ({ slot: 500_000_100, updatedAt: new Date() }));
  const streamed = await deploymentEnvelope(500_000_050);
  assert.equal(streamed.sourceSlot, 500_000_100);
  assert.ok(Date.now()-Date.parse(streamed.observedAt) < 1000);
  assert.deepEqual(rpc.slots, []);
  assert.deepEqual(observedFloors.slice(rpc.headers), []);
  // A capture past the stream observes the loader at its own slot, under the
  // same durable identity.
  const observed = await deploymentEnvelope(500_000_101);
  assert.equal(observed.sourceSlot, 500_000_101);
  assert.equal(observed.deploymentIdentitySha256, streamed.deploymentIdentitySha256);
  assert.deepEqual(observedFloors.slice(rpc.headers), [500_000_101]);
});

test('a stale or unattested stream serves no identity', async (context) => {
  chain(context);
  let stream: { slot: number; updatedAt: Date } | null = { slot: 500_000_100, updatedAt: new Date(Date.now()-16_000) };
  context.mock.method(coverage, 'readStreamedDeployment', async () => stream);
  await assert.rejects(deploymentEnvelope(), (error: Error & { status?: number }) => /stale/.test(error.message) && error.status === 503);
  stream = null;
  await assert.rejects(deploymentEnvelope(), (error: Error & { status?: number }) => /not attested/.test(error.message) && error.status === 503);
});

test('coalesced capture observations rebuild at the higher caller floor and reject a lagging tip', async (context) => {
  // Floors stay above the earlier test's observation: the process never
  // observes below a slot it has already served.
  const rpc = chain(context);
  context.mock.method(coverage, 'readStreamedDeployment', async () => ({ slot: 499_000_000, updatedAt: new Date() }));
  let release: () => void = () => undefined;
  const hold = new Promise<void>(resolve => { release = resolve; });
  let invalidTip: number | undefined;
  context.mock.method(Connection.prototype, 'getSlot', async (options: { minContextSlot: number }) => {
    rpc.slots.push(options.minContextSlot);
    if (rpc.slots.length === 1) await hold;
    return invalidTip ?? options.minContextSlot;
  });
  const low = deploymentEnvelope(500_001_000);
  await setImmediate();
  const high = deploymentEnvelope(500_001_005);
  release();
  assert.equal((await low).sourceSlot, 500_001_000);
  assert.equal((await high).sourceSlot, 500_001_005);
  assert.deepEqual(rpc.slots, [500_001_000, 500_001_005]);
  assert.deepEqual(observedFloors.slice(rpc.headers), rpc.slots);
  for (const tip of [500_001_009, NaN, Infinity, 500_001_010.5]) {
    invalidTip = tip;
    await assert.rejects(deploymentEnvelope(500_001_010), /source-slot floor 500001010/);
  }
  assert.deepEqual(rpc.slots.slice(2), [500_001_010, 500_001_010, 500_001_010, 500_001_010]);
  for (const floor of [-1, NaN, 0.5, Infinity])
    await assert.rejects(deploymentEnvelope(floor), /Invalid deployment/);
});

test('a live capture observes its bank even when the ingestion cursor is available but behind', async (context) => {
  const rpc = chain(context);
  context.mock.method(coverage, 'readStreamedDeployment', async () => {
    throw new Error('A live capture must not reuse the ingestion cursor');
  });
  context.mock.method(Connection.prototype, 'getSlot', async (options: { minContextSlot: number }) => {
    rpc.slots.push(options.minContextSlot);
    return options.minContextSlot;
  });
  const observed = await observedDeploymentEnvelope(500_002_000);
  assert.equal(observed.sourceSlot, 500_002_000);
  assert.deepEqual(rpc.slots, [500_002_000]);
  assert.deepEqual(observedFloors.slice(rpc.headers), [500_002_000]);
});
