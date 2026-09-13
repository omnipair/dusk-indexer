/**
 * The Dusk deployment envelope.
 *
 * Every Dusk response carries the identity of the deployment it was read
 * from, so a client can refuse data from a program it was not built against.
 * The envelope is assembled from two sources that must agree: the vendored
 * `protocol/` pin (program ids, IDL digests, attested binary hashes) and a
 * live observation of the upgradeable-loader accounts on chain.
 *
 * Concurrent envelope reads share an observation. Ordinary identity responses
 * may use the short-lived cache; bracketed data reads explicitly request fresh
 * loader observations before and after the payload is read.
 */

import { Connection } from '@solana/web3.js';
import { createDuskProgramObserver } from './duskProgramObservation';

import {
  DUSK_DEPLOYMENT_COMMITMENT,
  DUSK_DEPLOYMENT_SCHEMA_VERSION,
  canonicalJson,
  duskApiConfig,
  loadPinnedProtocol,
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

function deploymentIdentityFingerprint(
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

async function buildEnvelope(minimumSourceSlot: number): Promise<DuskDeploymentEnvelope> {
  const pinned = loadPinnedProtocol();
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

  const envelope = {
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
  };

  return {
    ...envelope,
    deploymentIdentitySha256: deploymentIdentityFingerprint(envelope),
  };
}

let cached: { value: DuskDeploymentEnvelope; observedAtMs: number } | undefined;
let inflight: Promise<DuskDeploymentEnvelope> | undefined;

/**
 * @param minimumSourceSlot The envelope must be at least this fresh. A payload
 * read at slot N cannot be stamped with an envelope observed before N — the
 * client rejects that as a source-slot mismatch, correctly, since the identity
 * would not yet have covered the data. A cached envelope below the floor is
 * rebuilt rather than returned.
 */
export async function deploymentEnvelope(
  minimumSourceSlot = 0,
  options: { fresh?: boolean } = {},
): Promise<DuskDeploymentEnvelope> {
  if (!Number.isSafeInteger(minimumSourceSlot) || minimumSourceSlot < 0)
    throw new Error('Invalid deployment source-slot floor');
  const { config: apiConfig } = runtime();
  if (
    !options.fresh && cached &&
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

/** Bind the complete read, including cache lookup, to one fresh identity. */
export async function withDeploymentRead<T>(
  read: (deployment: DuskDeploymentEnvelope) => Promise<{ data: T; sourceSlot: number }>,
): Promise<{ success: true; data: T; deployment: DuskDeploymentEnvelope }> {
  const before = await deploymentEnvelope(0, { fresh: true });
  const { data, sourceSlot } = await read(before);
  const after = await deploymentEnvelope(Math.max(sourceSlot, before.sourceSlot), { fresh: true });
  if (before.deploymentIdentitySha256 !== after.deploymentIdentitySha256) {
    throw new Error('Deployment changed during the read');
  }
  return { success: true, data, deployment: after };
}
