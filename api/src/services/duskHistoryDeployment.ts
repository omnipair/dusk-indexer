import { PoolClient } from 'pg';
import { DUSK_DEPLOYMENT_COMMITMENT, DUSK_DEPLOYMENT_SCHEMA_VERSION, DuskPinnedProtocol, loadPinnedProtocol } from '../config/duskProtocol';
import { DuskDeploymentEnvelope, deploymentIdentityFingerprint } from './duskDeploymentService';

const identity = (pin = loadPinnedProtocol()) => {
  return [pin.cluster,pin.dusk.programId,pin.dusk.idlCanonicalSha256,pin.revision];
};

/** Verify the complete saved identity against the active pin, including both
 * loader slots, authorities, binaries and IDLs. Only buildRevision may differ.
 * Live reads/writes continue to compare the original full envelope hash. */
export function assertPinnedHistoryDeployment(envelope: DuskDeploymentEnvelope,pin: DuskPinnedProtocol = loadPinnedProtocol()) {
  const expected = {
    ...envelope,schemaVersion: DUSK_DEPLOYMENT_SCHEMA_VERSION,network: pin.cluster,genesisHash: pin.genesisHash,
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
  };
  if (typeof envelope.buildRevision !== 'string' || !envelope.buildRevision.trim()
    || !Number.isSafeInteger(envelope.sourceSlot) || envelope.sourceSlot<pin.historyFirstSlot
    || !Number.isFinite(Date.parse(envelope.observedAt))
    || deploymentIdentityFingerprint(envelope) !== envelope.deploymentIdentitySha256
    || deploymentIdentityFingerprint(expected) !== envelope.deploymentIdentitySha256)
    throw new Error('FINALIZED_INVARIANT: historical deployment differs from its hash or pinned release');
}

/** Called with a fresh, RPC-verified envelope before storing capture bytes. */
export async function storeCaptureDeployment(client: PoolClient,envelope: DuskDeploymentEnvelope) {
  assertPinnedHistoryDeployment(envelope);
  await client.query(`INSERT INTO dusk_ingestion.capture_deployments
    (cluster,program_id,idl_hash,protocol_revision,deployment_identity_sha256,envelope)
    VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(deployment_identity_sha256) DO NOTHING`,
    [...identity(),envelope.deploymentIdentitySha256,JSON.stringify(envelope)]);
}

export interface HistoryDeploymentQuery {
  deploymentIdentitySha256: string;
  /** Only the route's verified envelope can broaden an exact-hash selection. */
  deployment?: DuskDeploymentEnvelope;
}
export async function historyDeploymentIdentities(client: PoolClient,query: HistoryDeploymentQuery,pin: DuskPinnedProtocol = loadPinnedProtocol()): Promise<string[]> {
  if (!query.deployment) return [query.deploymentIdentitySha256];
  assertPinnedHistoryDeployment(query.deployment,pin);
  if (query.deployment.deploymentIdentitySha256 !== query.deploymentIdentitySha256)
    throw new Error('Historical query differs from its verified deployment');
  const rows = await client.query<{ deployment_identity_sha256: string; envelope: DuskDeploymentEnvelope }>(`
    SELECT deployment_identity_sha256,envelope FROM dusk_ingestion.capture_deployments
    WHERE cluster=$1 AND program_id=$2 AND idl_hash=$3 AND protocol_revision=$4`,identity(pin));
  const hashes = new Set([query.deploymentIdentitySha256]);
  for (const row of rows.rows) {
    assertPinnedHistoryDeployment(row.envelope,pin);
    if (row.envelope.deploymentIdentitySha256 !== row.deployment_identity_sha256)
      throw new Error('FINALIZED_INVARIANT: historical deployment registration changed');
    hashes.add(row.deployment_identity_sha256);
  }
  return [...hashes];
}
