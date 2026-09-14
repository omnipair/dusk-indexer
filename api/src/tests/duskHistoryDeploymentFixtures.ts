import { DUSK_DEPLOYMENT_COMMITMENT, DUSK_DEPLOYMENT_SCHEMA_VERSION, loadPinnedProtocol } from '../config/duskProtocol';
import { DuskDeploymentEnvelope, deploymentIdentityFingerprint } from '../services/duskDeploymentService';

export function historyDeploymentFixture(buildRevision = 'fixture-api-release'): DuskDeploymentEnvelope {
  const pin = loadPinnedProtocol();
  const envelope = {
    schemaVersion: DUSK_DEPLOYMENT_SCHEMA_VERSION,network: pin.cluster,genesisHash: pin.genesisHash,
    programId: pin.dusk.programId,programDataAddress: pin.dusk.deployment.programData,
    programDataSlot: String(pin.dusk.deployment.deploySlot),programUpgradeAuthority: pin.dusk.deployment.upgradeAuthority,
    leverageDelegateProgramId: pin.leverageDelegate.programId,
    leverageDelegateProgramDataAddress: pin.leverageDelegate.deployment.programData,
    leverageDelegateProgramDataSlot: String(pin.leverageDelegate.deployment.deploySlot),
    leverageDelegateUpgradeAuthority: pin.leverageDelegate.deployment.upgradeAuthority,
    idlSha256: pin.dusk.idlCanonicalSha256,idlRawSha256: pin.dusk.idlRawSha256,
    leverageDelegateIdlSha256: pin.leverageDelegate.idlCanonicalSha256,
    leverageDelegateIdlRawSha256: pin.leverageDelegate.idlRawSha256,
    commitment: DUSK_DEPLOYMENT_COMMITMENT,programBinarySha256: pin.dusk.binarySha256,
    leverageDelegateBinarySha256: pin.leverageDelegate.binarySha256,
    buildRevision,sourceSlot: pin.historyFirstSlot+1000,observedAt: '2026-09-14T00:00:00Z',apiStartedAt: null,
  };
  return { ...envelope,deploymentIdentitySha256: deploymentIdentityFingerprint(envelope) };
}
