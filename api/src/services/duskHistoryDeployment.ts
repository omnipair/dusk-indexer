import { PoolClient } from 'pg';
import { DUSK_DEPLOYMENT_COMMITMENT, DUSK_DEPLOYMENT_SCHEMA_VERSION, DuskPinnedProtocol, loadCurrentProtocol, loadPinnedProtocol } from '../config/duskProtocol';
import { DuskDeploymentEnvelope, deploymentIdentityFingerprint } from './duskDeploymentService';

const identity = (pin = loadPinnedProtocol()) => {
  return [pin.cluster,pin.dusk.programId,pin.dusk.idlCanonicalSha256,pin.revision];
};

/** Historical captures retain their exact deployment. The original release
 * and its reviewed, IDL-compatible upgrade share one event revision; all
 * other loader slots, authorities and binaries still fail closed. */
export function assertPinnedHistoryDeployment(envelope: DuskDeploymentEnvelope,pin: DuskPinnedProtocol = loadPinnedProtocol()) {
  const expectedFor = (candidate: DuskPinnedProtocol) => ({
    ...envelope,schemaVersion: DUSK_DEPLOYMENT_SCHEMA_VERSION,network: pin.cluster,genesisHash: pin.genesisHash,
    programId: candidate.dusk.programId,programDataAddress: candidate.dusk.deployment.programData,
    programDataSlot: String(candidate.dusk.deployment.deploySlot),programUpgradeAuthority: candidate.dusk.deployment.upgradeAuthority,
    leverageDelegateProgramId: candidate.leverageDelegate.programId,
    leverageDelegateProgramDataAddress: candidate.leverageDelegate.deployment.programData,
    leverageDelegateProgramDataSlot: String(candidate.leverageDelegate.deployment.deploySlot),
    leverageDelegateUpgradeAuthority: candidate.leverageDelegate.deployment.upgradeAuthority,
    idlSha256: candidate.dusk.idlCanonicalSha256,idlRawSha256: candidate.dusk.idlRawSha256,
    leverageDelegateIdlSha256: candidate.leverageDelegate.idlCanonicalSha256,
    leverageDelegateIdlRawSha256: candidate.leverageDelegate.idlRawSha256,
    commitment: DUSK_DEPLOYMENT_COMMITMENT,programBinarySha256: candidate.dusk.binarySha256,
    leverageDelegateBinarySha256: candidate.leverageDelegate.binarySha256,
  });
  const current = pin.revision === loadPinnedProtocol().revision ? loadCurrentProtocol() : null;
  const candidates = current ? [pin,current] : [pin];
  if (typeof envelope.buildRevision !== 'string' || !envelope.buildRevision.trim()
    || !Number.isSafeInteger(envelope.sourceSlot) || envelope.sourceSlot<pin.historyFirstSlot
    || !Number.isFinite(Date.parse(envelope.observedAt))
    || deploymentIdentityFingerprint(envelope) !== envelope.deploymentIdentitySha256
    || !candidates.some(candidate =>
      envelope.sourceSlot >= candidate.dusk.deployment.deploySlot + 1 &&
      (candidate === current || !current || envelope.sourceSlot < current.dusk.deployment.deploySlot) &&
      deploymentIdentityFingerprint(expectedFor(candidate)) === envelope.deploymentIdentitySha256))
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
