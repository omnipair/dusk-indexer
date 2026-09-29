import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCurrentProtocol } from '../config/duskProtocol';
import { deploymentIdentityFingerprint, DuskDeploymentEnvelope } from '../services/duskDeploymentService';
import { assertPinnedHistoryDeployment } from '../services/duskHistoryDeployment';
import { historyDeploymentFixture } from './duskHistoryDeploymentFixtures';

test('history accepts program upgrades while keeping the protocol identity',() => {
  const original = historyDeploymentFixture(),release = historyDeploymentFixture('fixture-next-api-release');
  assert.notEqual(original.deploymentIdentitySha256,release.deploymentIdentitySha256);
  assertPinnedHistoryDeployment(original); assertPinnedHistoryDeployment(release);
  const current = loadCurrentProtocol();
  const lateOriginal = { ...original, sourceSlot: current.dusk.deployment.deploySlot + 1 };
  assertPinnedHistoryDeployment(lateOriginal);
  const upgraded = {
    ...release,
    sourceSlot: current.dusk.deployment.deploySlot + 1,
    programDataSlot: String(current.dusk.deployment.deploySlot),
    programBinarySha256: current.dusk.binarySha256,
  };
  const upgradedEnvelope = {
    ...upgraded,
    deploymentIdentitySha256: deploymentIdentityFingerprint(upgraded),
  };
  assertPinnedHistoryDeployment(upgradedEnvelope);
  const anotherBinary = { ...upgradedEnvelope, programBinarySha256: '0'.repeat(64) };
  assertPinnedHistoryDeployment({ ...anotherBinary, deploymentIdentitySha256: deploymentIdentityFingerprint(anotherBinary) });
  for (const changed of [
    { ...upgradedEnvelope, sourceSlot: current.dusk.deployment.deploySlot },
    { ...upgradedEnvelope, programDataSlot: String(current.dusk.deployment.deploySlot + 1) },
  ]) {
    const candidate = { ...changed, deploymentIdentitySha256: deploymentIdentityFingerprint(changed) };
    assert.throws(() => assertPinnedHistoryDeployment(candidate), /historical deployment/);
  }
  const fields: (keyof DuskDeploymentEnvelope)[] = ['schemaVersion','network','genesisHash','programId','programDataAddress',
    'leverageDelegateProgramId','leverageDelegateProgramDataAddress','idlSha256','idlRawSha256',
    'leverageDelegateIdlSha256','leverageDelegateIdlRawSha256','commitment'];
  for (const key of fields) {
    const changed = { ...original,[key]: `changed-${original[key]}` };
    changed.deploymentIdentitySha256 = deploymentIdentityFingerprint(changed);
    assert.throws(() => assertPinnedHistoryDeployment(changed),/historical deployment/,key);
  }
  assert.throws(() => assertPinnedHistoryDeployment({ ...original,buildRevision: 'unhashed-change' }),/historical deployment/);
  assert.throws(() => assertPinnedHistoryDeployment({ ...original,sourceSlot: 1 }),/historical deployment/);
});
