import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPinnedProtocol,parseProgramDeployment } from '../config/duskProtocol';

test('deployment starts after both pinned upgrades and preserves exact on-chain identity',() => {
  const pin=loadPinnedProtocol();
  assert.equal(pin.historyFirstSlot,499930982);
  assert.deepEqual(parseProgramDeployment(pin.dusk.deployment,pin.dusk.programId),pin.dusk.deployment);
});
test('missing authority and invalid ProgramData, deployment slot or allocation cannot form a pin',() => {
  const pin=loadPinnedProtocol().dusk;
  for (const change of [{programData:pin.programId},{deploySlot:0},{deploySlot:Number.MAX_SAFE_INTEGER},
    {allocatedBinaryBytes:0},{upgradeAuthority:undefined},{upgradeAuthority:'invalid'}]) {
    assert.throws(() => parseProgramDeployment({...pin.deployment,...change},pin.programId));
  }
  assert.throws(() => parseProgramDeployment(undefined,pin.programId));
  assert.equal(parseProgramDeployment({...pin.deployment,upgradeAuthority:null},pin.programId).upgradeAuthority,null);
});
