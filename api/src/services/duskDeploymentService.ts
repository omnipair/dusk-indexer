/**
 * The Dusk deployment envelope.
 *
 * Every Dusk response carries the identity of the deployment it was read
 * from, so a client can refuse data from a program it was not built against.
 * The identity is the vendored protocol pin: cluster, program IDs, IDL digests,
 * event revision and the executable metadata recorded for the current release
 * (`protocol/compatible-deployment.json`). It is not re-read from the chain for
 * each response. The RPC's genesis hash is checked once per process so a
 * misconfigured endpoint cannot serve another cluster's state.
 */

import { Connection } from '@solana/web3.js';
import { readStreamedDeployment } from './duskHistoryCoverage';

import {
  DUSK_DEPLOYMENT_COMMITMENT,
  DUSK_DEPLOYMENT_SCHEMA_VERSION,
  canonicalJson,
  duskApiConfig,
  loadCurrentProtocol,
  sha256,
} from '../config/duskProtocol';

export interface DuskDeploymentEnvelope {
  readonly schemaVersion: string;
  readonly network: string;
  readonly genesisHash: string;
  readonly programId: string;
  readonly programDataAddress: string;
  readonly programDataSlot: string;
  readonly programUpgradeAuthority: string | null;
  readonly leverageDelegateProgramId: string;
  readonly leverageDelegateProgramDataAddress: string;
  readonly leverageDelegateProgramDataSlot: string;
  readonly leverageDelegateUpgradeAuthority: string | null;
  readonly idlSha256: string;
  readonly idlRawSha256: string;
  readonly leverageDelegateIdlSha256: string;
  readonly leverageDelegateIdlRawSha256: string | null;
  readonly commitment: string;
  readonly sourceSlot: number;
  readonly observedAt: string;
  readonly apiStartedAt: string | null;
  readonly buildRevision: string;
  readonly programBinarySha256: string;
  readonly leverageDelegateBinarySha256: string;
  readonly deploymentIdentitySha256: string;
}

const API_STARTED_AT = new Date().toISOString();

export function deploymentIdentityFingerprint(
  deployment: Omit<DuskDeploymentEnvelope, 'deploymentIdentitySha256'>,
): string {
  return sha256(
    canonicalJson({
      schemaVersion: deployment.schemaVersion,
      network: deployment.network,
      genesisHash: deployment.genesisHash,
      programId: deployment.programId,
      programDataAddress: deployment.programDataAddress,
      programDataSlot: deployment.programDataSlot,
      programUpgradeAuthority: deployment.programUpgradeAuthority,
      leverageDelegateProgramId: deployment.leverageDelegateProgramId,
      leverageDelegateProgramDataAddress:
        deployment.leverageDelegateProgramDataAddress,
      leverageDelegateProgramDataSlot: deployment.leverageDelegateProgramDataSlot,
      leverageDelegateUpgradeAuthority: deployment.leverageDelegateUpgradeAuthority,
      idlSha256: deployment.idlSha256,
      idlRawSha256: deployment.idlRawSha256,
      leverageDelegateIdlSha256: deployment.leverageDelegateIdlSha256,
      leverageDelegateIdlRawSha256: deployment.leverageDelegateIdlRawSha256,
      commitment: deployment.commitment,
      buildRevision: deployment.buildRevision,
      programBinarySha256: deployment.programBinarySha256,
      leverageDelegateBinarySha256: deployment.leverageDelegateBinarySha256,
    }),
  );
}

/** The daemon heartbeats every 5 s while its WebSocket is live. */
export const DUSK_STREAM_STALE_MS = 15_000;

function withIdentity(envelope: Omit<DuskDeploymentEnvelope, 'deploymentIdentitySha256'>): DuskDeploymentEnvelope {
  return { ...envelope,deploymentIdentitySha256: deploymentIdentityFingerprint(envelope) };
}

const verifiedGenesis = new Map<string, Promise<string>>();

/** Check the RPC's cluster once per endpoint; a failed lookup is retried by the next envelope. */
function rpcGenesis(rpcUrl: string, pinned: string): Promise<string> {
  let pending = verifiedGenesis.get(rpcUrl);
  if (!pending) {
    pending = new Connection(rpcUrl, DUSK_DEPLOYMENT_COMMITMENT).getGenesisHash().then((genesisHash) => {
      if (genesisHash !== pinned)
        throw new Error(`RPC genesis ${genesisHash} does not match the pinned cluster ${pinned}`);
      return genesisHash;
    });
    verifiedGenesis.set(rpcUrl, pending);
    const owned = pending;
    void owned.catch(() => {
      if (verifiedGenesis.get(rpcUrl) === owned) verifiedGenesis.delete(rpcUrl);
    });
  }
  return pending;
}

async function pinnedEnvelope(sourceSlot: number): Promise<DuskDeploymentEnvelope> {
  const pinned = loadCurrentProtocol();
  const apiConfig = duskApiConfig();
  const { dusk, leverageDelegate } = pinned;
  return withIdentity({
    schemaVersion: DUSK_DEPLOYMENT_SCHEMA_VERSION,
    network: apiConfig.network,
    genesisHash: await rpcGenesis(apiConfig.rpcUrl, pinned.genesisHash),
    programId: dusk.programId,
    programDataAddress: dusk.deployment.programData,
    programDataSlot: String(dusk.deployment.deploySlot),
    programUpgradeAuthority: dusk.deployment.upgradeAuthority,
    leverageDelegateProgramId: leverageDelegate.programId,
    leverageDelegateProgramDataAddress: leverageDelegate.deployment.programData,
    leverageDelegateProgramDataSlot: String(leverageDelegate.deployment.deploySlot),
    leverageDelegateUpgradeAuthority: leverageDelegate.deployment.upgradeAuthority,
    idlSha256: dusk.idlCanonicalSha256,
    idlRawSha256: dusk.idlRawSha256,
    leverageDelegateIdlSha256: leverageDelegate.idlCanonicalSha256,
    leverageDelegateIdlRawSha256: leverageDelegate.idlRawSha256,
    commitment: DUSK_DEPLOYMENT_COMMITMENT,
    sourceSlot,
    observedAt: new Date().toISOString(),
    apiStartedAt: API_STARTED_AT,
    buildRevision: apiConfig.buildRevision,
    programBinarySha256: dusk.binarySha256,
    leverageDelegateBinarySha256: leverageDelegate.binarySha256,
  });
}

function assertSlot(slot: number) {
  if (!Number.isSafeInteger(slot) || slot < 0)
    throw new Error('Invalid deployment source-slot floor');
}

/**
 * @param minimumSourceSlot The envelope must cover this slot. A payload read
 * at slot N cannot be stamped with an envelope below N — the client rejects
 * that as a source-slot mismatch. Database reads sit at or below the stream's
 * slot and take the stream's envelope, which requires a live stream.
 */
export async function deploymentEnvelope(minimumSourceSlot = 0): Promise<DuskDeploymentEnvelope> {
  assertSlot(minimumSourceSlot);
  const stream = await readStreamedDeployment();
  if (!stream) throw Object.assign(new Error('The Dusk stream has not attested this release'),{ status: 503 });
  if (Date.now()-stream.updatedAt.getTime()>DUSK_STREAM_STALE_MS)
    throw Object.assign(new Error('The Dusk stream is stale'),{ status: 503 });
  return pinnedEnvelope(Math.max(stream.slot, minimumSourceSlot));
}

/** Live RPC captures can run ahead of the ingestion cursor and do not depend
 * on it; their envelope covers the capture's own slot. */
export async function deploymentEnvelopeAt(sourceSlot: number): Promise<DuskDeploymentEnvelope> {
  assertSlot(sourceSlot);
  return pinnedEnvelope(sourceSlot);
}

/** Wrap a payload in the identity envelope every Dusk client validates. */
export async function withDeployment<T>(
  data: T,
  minimumSourceSlot = 0,
): Promise<{ success: true; data: T; deployment: DuskDeploymentEnvelope }> {
  return {
    success: true,
    data,
    deployment: await deploymentEnvelope(minimumSourceSlot),
  };
}

/** Bind the complete read, including cache lookup, to one identity that
 * covers its highest slot. */
export async function withDeploymentRead<T>(
  read: (deployment: DuskDeploymentEnvelope) => Promise<{ data: T; sourceSlot: number }>,
): Promise<{ success: true; data: T; deployment: DuskDeploymentEnvelope }> {
  const before = await deploymentEnvelope();
  const { data, sourceSlot } = await read(before);
  const after = await deploymentEnvelope(Math.max(sourceSlot, before.sourceSlot));
  if (before.deploymentIdentitySha256 !== after.deploymentIdentitySha256) {
    throw new Error('Deployment changed during the read');
  }
  return { success: true, data, deployment: after };
}
