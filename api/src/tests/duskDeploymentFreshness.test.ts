import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { Connection } from '@solana/web3.js';
import { deploymentEnvelope } from '../services/duskDeploymentService';
import { loadPinnedProtocol } from '../config/duskProtocol';
import type { DuskPinnedProgram } from '../config/duskProtocol';

const protocol = require('../config/duskProtocol') as typeof import('../config/duskProtocol');
const observation = require('../services/duskProgramObservation') as typeof import('../services/duskProgramObservation');

test('coalesced deployment checks rebuild at the higher caller floor and reject a lagging tip', async (context) => {
  const pinned = loadPinnedProtocol(), floors: number[] = [], headerFloors: number[] = [];
  context.mock.method(protocol, 'duskApiConfig', () => ({ network: 'devnet', rpcUrl: 'http://localhost:1', buildRevision: 'test', envelopeCacheTtlMs: 0 }));
  context.mock.method(Connection.prototype, 'getGenesisHash', async () => pinned.genesisHash);
  let release: () => void = () => undefined;
  const hold = new Promise<void>(resolve => { release = resolve; });
  let invalidTip: number | undefined;
  context.mock.method(Connection.prototype, 'getSlot', async (options: { minContextSlot: number }) => {
    floors.push(options.minContextSlot);
    if (floors.length === 1) await hold;
    return invalidTip ?? options.minContextSlot;
  });
  context.mock.method(observation, 'createDuskProgramObserver', () => async (pins: readonly DuskPinnedProgram[], floor: number) => {
    headerFloors.push(floor);
    return pins.map(pin => ({ programDataAddress: pin.deployment.programData, programDataSlot: String(pin.deployment.deploySlot), upgradeAuthority: pin.deployment.upgradeAuthority, binarySha256: pin.binarySha256, sourceSlot: floor }));
  });
  const low = deploymentEnvelope(500_000_000, { fresh: true });
  await setImmediate();
  const high = deploymentEnvelope(500_000_005, { fresh: true });
  release();
  assert.equal((await low).sourceSlot, 500_000_000);
  assert.equal((await high).sourceSlot, 500_000_005);
  assert.deepEqual(floors, [500_000_000, 500_000_005]);
  assert.deepEqual(headerFloors, floors);
  for (const tip of [500_000_009, NaN, Infinity, 500_000_010.5]) {
    invalidTip = tip;
    await assert.rejects(deploymentEnvelope(500_000_010, { fresh: true }), /source-slot floor 500000010/);
  }
  assert.deepEqual(floors.slice(2), [500_000_010, 500_000_010, 500_000_010, 500_000_010]);
  for (const floor of [-1, NaN, 0.5, Infinity])
    await assert.rejects(deploymentEnvelope(floor), /Invalid deployment/);
});
