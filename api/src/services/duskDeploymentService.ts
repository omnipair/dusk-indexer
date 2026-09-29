/**
 * The Dusk deployment envelope.
 *
 * Every Dusk response carries the identity of the deployment it was read
 * from, so a client can refuse data from a program it was not built against.
 * The protocol identity is the vendored cluster, program IDs, IDL digests and
 * event revision. Executable metadata is observed from the chain for capture
 * provenance, but a binary change does not stop ingestion or require a new
 * indexer build. The original event revision stays registered in the database.
 */

import { Connection } from '@solana/web3.js';
import { createDuskProgramObserver } from './duskProgramObservation';
import { readStreamedDeployment } from './duskHistoryCoverage';

import {
  DUSK_DEPLOYMENT_COMMITMENT,
  DUSK_DEPLOYMENT_SCHEMA_VERSION,
  canonicalJson,
  duskApiConfig,
  loadCurrentProtocol,
  sha256,
} from '../config/duskProtocol';

import type { DuskApiConfig } from '../config/duskProtocol';

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

let connection: Connection | undefined;
let config: DuskApiConfig | undefined;

function runtime(): { connection: Connection; config: DuskApiConfig } {
  if (!connection || !config) {
    config = duskApiConfig();
    connection = new Connection(config.rpcUrl, DUSK_DEPLOYMENT_COMMITMENT);
  }
  return { connection, config };
}

let observePrograms: ReturnType<typeof createDuskProgramObserver> | undefined;

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

/** Use the stream cursor for liveness and observe current program metadata.
 * An authorized upgrade does not require a new binary pin in this service. */
async function streamedEnvelope(minimumSourceSlot = 0): Promise<DuskDeploymentEnvelope> {
  const stream = await readStreamedDeployment();
  if (!stream) throw Object.assign(new Error('The Dusk stream has not attested this release'),{ status: 503 });
  const now = Date.now();
  if (now-stream.updatedAt.getTime()>DUSK_STREAM_STALE_MS)
    throw Object.assign(new Error('The Dusk stream is stale'),{ status: 503 });
  return observedDeploymentEnvelope(Math.max(stream.slot, minimumSourceSlot));
}

async function buildEnvelope(minimumSourceSlot: number): Promise<DuskDeploymentEnvelope> {
  const pinned = loadCurrentProtocol();
  const { connection: rpc, config: apiConfig } = runtime();
  const floor = Math.max(minimumSourceSlot, cached?.value.sourceSlot ?? 0);

  // The pinned loader addresses can be read together while genesis and tip
  // checks run. No envelope is accepted until all three observations agree.
  observePrograms ??= createDuskProgramObserver(rpc);
  const [genesisHash, slot, programs] = await Promise.all([
    rpc.getGenesisHash(),
    rpc.getSlot({ commitment: DUSK_DEPLOYMENT_COMMITMENT, minContextSlot: floor }),
    observePrograms([pinned.dusk,pinned.leverageDelegate], floor),
  ]);
  const [duskProgram,delegateProgram] = programs;
  if (!Number.isSafeInteger(slot) || slot < floor)
    throw new Error(`RPC tip did not satisfy the deployment source-slot floor ${floor}`);
  if (genesisHash !== pinned.genesisHash) {
    throw new Error(
      `RPC genesis ${genesisHash} does not match the pinned cluster ${pinned.genesisHash}`,
    );
  }

  return withIdentity({
    schemaVersion: DUSK_DEPLOYMENT_SCHEMA_VERSION,
    network: apiConfig.network,
    genesisHash,
    programId: pinned.dusk.programId,
    programDataAddress: duskProgram.programDataAddress,
    programDataSlot: duskProgram.programDataSlot,
    programUpgradeAuthority: duskProgram.upgradeAuthority,
    leverageDelegateProgramId: pinned.leverageDelegate.programId,
    leverageDelegateProgramDataAddress: delegateProgram.programDataAddress,
    leverageDelegateProgramDataSlot: delegateProgram.programDataSlot,
    leverageDelegateUpgradeAuthority: delegateProgram.upgradeAuthority,
    idlSha256: pinned.dusk.idlCanonicalSha256,
    idlRawSha256: pinned.dusk.idlRawSha256,
    leverageDelegateIdlSha256: pinned.leverageDelegate.idlCanonicalSha256,
    leverageDelegateIdlRawSha256: pinned.leverageDelegate.idlRawSha256,
    commitment: DUSK_DEPLOYMENT_COMMITMENT,
    sourceSlot: Math.min(slot, duskProgram.sourceSlot, delegateProgram.sourceSlot),
    observedAt: new Date().toISOString(),
    apiStartedAt: API_STARTED_AT,
    buildRevision: apiConfig.buildRevision,
    programBinarySha256: duskProgram.binarySha256,
    leverageDelegateBinarySha256: delegateProgram.binarySha256,
  });
}

let cached: { value: DuskDeploymentEnvelope; observedAtMs: number } | undefined;
let inflight: Promise<DuskDeploymentEnvelope> | undefined;

/**
 * @param minimumSourceSlot The envelope must be at least this fresh. A payload
 * read at slot N cannot be stamped with an envelope observed before N — the
 * client rejects that as a source-slot mismatch, correctly, since the identity
 * would not yet have covered the data. Database reads sit at or below the
 * stream's slot and take the stream's envelope; a chain capture past it
 * observes the loader accounts at its own slot.
 */
export async function deploymentEnvelope(minimumSourceSlot = 0): Promise<DuskDeploymentEnvelope> {
  if (!Number.isSafeInteger(minimumSourceSlot) || minimumSourceSlot < 0)
    throw new Error('Invalid deployment source-slot floor');
  return streamedEnvelope(minimumSourceSlot);
}

/** Live RPC captures can run ahead of the ingestion cursor. Observe the
 * programs at the capture's bank instead of reusing the stream's older slot. */
export async function observedDeploymentEnvelope(minimumSourceSlot = 0): Promise<DuskDeploymentEnvelope> {
  if (!Number.isSafeInteger(minimumSourceSlot) || minimumSourceSlot < 0)
    throw new Error('Invalid deployment source-slot floor');
  const { config: apiConfig } = runtime();
  if (
    cached &&
    Date.now() - cached.observedAtMs < apiConfig.envelopeCacheTtlMs &&
    cached.value.sourceSlot >= minimumSourceSlot
  ) {
    return cached.value;
  }
  // Collapse concurrent refreshes; a cold start under load would otherwise
  // issue one full observation per in-flight request.
  if (!inflight) {
    inflight = buildEnvelope(minimumSourceSlot)
      .then((value) => {
        cached = { value, observedAtMs: Date.now() };
        return value;
      })
      .finally(() => {
        inflight = undefined;
      });
  }
  const envelope = await inflight;
  if (envelope.sourceSlot >= minimumSourceSlot) return envelope;

  // A coalesced request may have started with a lower floor. Rebuild once
  // with this caller's requirement; a node that ignores it is still rejected.
  const rebuilt = await buildEnvelope(minimumSourceSlot);
  cached = { value: rebuilt, observedAtMs: Date.now() };
  if (rebuilt.sourceSlot < minimumSourceSlot) {
    throw new Error(
      `deployment envelope observed slot ${rebuilt.sourceSlot} but the response needs at least ${minimumSourceSlot}`,
    );
  }
  return rebuilt;
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
