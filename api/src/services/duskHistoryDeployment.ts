import { PoolClient } from 'pg';
import { DUSK_DEPLOYMENT_COMMITMENT, DUSK_DEPLOYMENT_SCHEMA_VERSION, DuskPinnedProtocol, loadPinnedProtocol } from '../config/duskProtocol';
import { DuskDeploymentEnvelope, deploymentIdentityFingerprint } from './duskDeploymentService';

const identity = (pin = loadPinnedProtocol()) => {
  return [pin.cluster,pin.dusk.programId,pin.dusk.idlCanonicalSha256,pin.revision];
};

/** Historical captures retain the executable observed at capture time, while
 * the cluster/program/IDL/revision tuple scopes the event history. */
export function assertPinnedHistoryDeployment(envelope: DuskDeploymentEnvelope,pin: DuskPinnedProtocol = loadPinnedProtocol()) {
  const duskSlot = Number(envelope.programDataSlot);
  const delegateSlot = Number(envelope.leverageDelegateProgramDataSlot);
  if (typeof envelope.buildRevision !== 'string' || !envelope.buildRevision.trim()
    || !Number.isSafeInteger(envelope.sourceSlot) || envelope.sourceSlot<pin.historyFirstSlot
    || !Number.isFinite(Date.parse(envelope.observedAt))
    || deploymentIdentityFingerprint(envelope) !== envelope.deploymentIdentitySha256
    || envelope.schemaVersion !== DUSK_DEPLOYMENT_SCHEMA_VERSION
    || envelope.network !== pin.cluster || envelope.genesisHash !== pin.genesisHash
    || envelope.programId !== pin.dusk.programId || envelope.leverageDelegateProgramId !== pin.leverageDelegate.programId
    || envelope.programDataAddress !== pin.dusk.deployment.programData
    || envelope.leverageDelegateProgramDataAddress !== pin.leverageDelegate.deployment.programData
    || envelope.idlSha256 !== pin.dusk.idlCanonicalSha256 || envelope.idlRawSha256 !== pin.dusk.idlRawSha256
    || envelope.leverageDelegateIdlSha256 !== pin.leverageDelegate.idlCanonicalSha256
    || envelope.leverageDelegateIdlRawSha256 !== pin.leverageDelegate.idlRawSha256
    || envelope.commitment !== DUSK_DEPLOYMENT_COMMITMENT
    || !Number.isSafeInteger(duskSlot) || duskSlot < pin.dusk.deployment.deploySlot
    || !Number.isSafeInteger(delegateSlot) || delegateSlot < pin.leverageDelegate.deployment.deploySlot
    || duskSlot >= envelope.sourceSlot || delegateSlot >= envelope.sourceSlot
    || !/^[0-9a-f]{64}$/.test(envelope.programBinarySha256)
    || !/^[0-9a-f]{64}$/.test(envelope.leverageDelegateBinarySha256))
    throw new Error('FINALIZED_INVARIANT: historical deployment differs from its protocol identity');
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
