/**
 * The Dusk deployment envelope.
 *
 * Every Dusk response carries the identity of the deployment it was read
 * from, so a client can refuse data from a program it was not built against.
 * The envelope is assembled from two sources that must agree: the vendored
 * `protocol/` pin (program ids, IDL digests, attested binary hashes) and a
 * live observation of the upgradeable-loader accounts on chain.
 *
 * Chain observation is cached with a short TTL. The fork lab recomputed this
 * per request, which cost about a dozen RPC calls each and got the public
 * devnet endpoint to rate-limit us; a hosted API answers from cache and
 * refreshes on a timer instead.
 */

import { Connection, PublicKey } from '@solana/web3.js';

import {
  DUSK_DEPLOYMENT_COMMITMENT,
  DUSK_DEPLOYMENT_SCHEMA_VERSION,
  canonicalJson,
  duskApiConfig,
  loadPinnedProtocol,
  sha256,
} from '../config/duskProtocol';

import type { DuskApiConfig, DuskPinnedProgram } from '../config/duskProtocol';

const BPF_LOADER_UPGRADEABLE_ID = new PublicKey(
  'BPFLoaderUpgradeab1e11111111111111111111111',
);
const UPGRADEABLE_PROGRAM_TAG = 2;
const UPGRADEABLE_PROGRAM_DATA_TAG = 3;
const UPGRADEABLE_PROGRAM_DATA_METADATA_BYTES = 45;

export interface DuskDeploymentEnvelope {
  readonly schemaVersion: string;
  readonly network: string;
  readonly forkSourceNetwork: string;
  readonly genesisHash: string;
  readonly forkId: string;
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

/** A cluster's genesis hash never changes; read it once per process. */
let genesisHashPromise: Promise<string> | undefined;
function cachedGenesisHash(rpc: Connection): Promise<string> {
  if (!genesisHashPromise) {
    genesisHashPromise = rpc.getGenesisHash().catch((error) => {
      genesisHashPromise = undefined;
      throw error;
    });
  }
  return genesisHashPromise;
}

let connection: Connection | undefined;
let config: DuskApiConfig | undefined;

function runtime(): { connection: Connection; config: DuskApiConfig } {
  if (!connection || !config) {
    config = duskApiConfig();
    connection = new Connection(config.rpcUrl, DUSK_DEPLOYMENT_COMMITMENT);
  }
  return { connection, config };
}

interface ObservedProgram {
  programDataAddress: string;
  programDataSlot: string;
  upgradeAuthority: string | null;
  binarySha256: string;
  sourceSlot: number;
}

function parseProgramDataHeader(data: Buffer): {
  programDataSlot: string;
  upgradeAuthority: string | null;
} {
  if (data.length < 13 || data.readUInt32LE(0) !== UPGRADEABLE_PROGRAM_DATA_TAG) {
    throw new Error('Malformed upgradeable ProgramData header');
  }
  const programDataSlot = data.readBigUInt64LE(4).toString();
  const authorityOption = data[12];
  if (authorityOption === 0) return { programDataSlot, upgradeAuthority: null };
  if (
    authorityOption !== 1 ||
    data.length < UPGRADEABLE_PROGRAM_DATA_METADATA_BYTES
  ) {
    throw new Error('Malformed upgradeable ProgramData authority option');
  }
  return {
    programDataSlot,
    upgradeAuthority: new PublicKey(data.subarray(13, 45)).toBase58(),
  };
}

/**
 * Program binaries are megabytes and never change without the programdata
 * slot changing, so a hash is computed once per observed slot.
 */
const binaryHashes = new Map<string, Promise<string>>();

async function observeUpgradeableProgram(
  pinned: DuskPinnedProgram,
): Promise<ObservedProgram> {
  const { connection: rpc } = runtime();
  const programId = new PublicKey(pinned.programId);

  const programObservation = await rpc.getAccountInfoAndContext(programId, {
    commitment: DUSK_DEPLOYMENT_COMMITMENT,
    dataSlice: { offset: 0, length: 36 },
  });
  const programAccount = programObservation.value;
  if (!programAccount?.executable) {
    throw new Error(`Program ${pinned.programId} is missing or not executable`);
  }
  if (!programAccount.owner.equals(BPF_LOADER_UPGRADEABLE_ID)) {
    throw new Error(
      `Program ${pinned.programId} has unsupported loader ${programAccount.owner.toBase58()}`,
    );
  }
  if (
    programAccount.data.length < 36 ||
    programAccount.data.readUInt32LE(0) !== UPGRADEABLE_PROGRAM_TAG
  ) {
    throw new Error(
      `Program ${pinned.programId} has malformed upgradeable-loader state`,
    );
  }

  const programDataAddress = new PublicKey(programAccount.data.subarray(4, 36));
  const programDataObservation = await rpc.getAccountInfoAndContext(
    programDataAddress,
    {
      commitment: DUSK_DEPLOYMENT_COMMITMENT,
      dataSlice: { offset: 0, length: UPGRADEABLE_PROGRAM_DATA_METADATA_BYTES },
    },
  );
  const programDataAccount = programDataObservation.value;
  if (
    !programDataAccount ||
    !programDataAccount.owner.equals(BPF_LOADER_UPGRADEABLE_ID)
  ) {
    throw new Error(
      `Program data ${programDataAddress.toBase58()} for ${pinned.programId} is missing or has the wrong loader`,
    );
  }

  const header = parseProgramDataHeader(programDataAccount.data);
  const cacheKey = canonicalJson({
    programId: pinned.programId,
    programDataAddress: programDataAddress.toBase58(),
    programDataSlot: header.programDataSlot,
    upgradeAuthority: header.upgradeAuthority,
  });

  let binaryHash = binaryHashes.get(cacheKey);
  if (!binaryHash) {
    binaryHash = hashProgramBinary(
      rpc,
      programDataAddress,
      pinned,
      header.programDataSlot,
      header.upgradeAuthority,
    );
    binaryHashes.set(cacheKey, binaryHash);
    binaryHash.catch(() => binaryHashes.delete(cacheKey));
  }

  return {
    programDataAddress: programDataAddress.toBase58(),
    programDataSlot: header.programDataSlot,
    upgradeAuthority: header.upgradeAuthority,
    binarySha256: await binaryHash,
    sourceSlot: Math.min(
      programObservation.context.slot,
      programDataObservation.context.slot,
    ),
  };
}

async function hashProgramBinary(
  rpc: Connection,
  programDataAddress: PublicKey,
  pinned: DuskPinnedProgram,
  expectedSlot: string,
  expectedAuthority: string | null,
): Promise<string> {
  const observation = await rpc.getAccountInfoAndContext(programDataAddress, {
    commitment: DUSK_DEPLOYMENT_COMMITMENT,
  });
  const account = observation.value;
  if (!account || !account.owner.equals(BPF_LOADER_UPGRADEABLE_ID)) {
    throw new Error(
      `Program data ${programDataAddress.toBase58()} changed while hashing ${pinned.programId}`,
    );
  }
  if (account.data.length <= UPGRADEABLE_PROGRAM_DATA_METADATA_BYTES) {
    throw new Error(
      `Program data ${programDataAddress.toBase58()} for ${pinned.programId} has no binary payload`,
    );
  }
  const header = parseProgramDataHeader(account.data);
  if (
    header.programDataSlot !== expectedSlot ||
    header.upgradeAuthority !== expectedAuthority
  ) {
    throw new Error(
      `Program data ${programDataAddress.toBase58()} changed while its binary was being hashed`,
    );
  }

  const observed = sha256(
    account.data.subarray(UPGRADEABLE_PROGRAM_DATA_METADATA_BYTES),
  );
  // The lock attests what this revision was built from. A live binary that
  // disagrees means the chain moved past the vendored pin, and serving the
  // pinned identity anyway would be a false attestation.
  if (observed !== pinned.binarySha256) {
    throw new Error(
      `Program ${pinned.programId} on chain hashes to ${observed} but protocol.lock.json pins ${pinned.binarySha256}; re-pin the protocol artifacts`,
    );
  }
  return observed;
}

function deploymentIdentityFingerprint(
  deployment: Omit<DuskDeploymentEnvelope, 'deploymentIdentitySha256'>,
): string {
  return sha256(
    canonicalJson({
      schemaVersion: deployment.schemaVersion,
      network: deployment.network,
      forkSourceNetwork: deployment.forkSourceNetwork,
      genesisHash: deployment.genesisHash,
      forkId: deployment.forkId,
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

async function buildEnvelope(): Promise<DuskDeploymentEnvelope> {
  const pinned = loadPinnedProtocol();
  const { connection: rpc, config: apiConfig } = runtime();

  const [genesisHash, slot] = await Promise.all([
    cachedGenesisHash(rpc),
    rpc.getSlot(DUSK_DEPLOYMENT_COMMITMENT),
  ]);
  if (genesisHash !== pinned.genesisHash) {
    throw new Error(
      `RPC genesis ${genesisHash} does not match the pinned cluster ${pinned.genesisHash}`,
    );
  }

  // A real cluster never resets underneath its clients, so the deployment
  // itself is the generation: a marker derived from genesis and program id is
  // stable across restarts and changes only when the deployment does.
  const markerData = sha256(
    `dusk-static-generation:${genesisHash}:${pinned.dusk.programId}`,
  );
  const forkId = `${apiConfig.network}-${sha256(
    `${apiConfig.forkNamespace}:${genesisHash}:${pinned.dusk.programId}:${markerData}`,
  )}`;

  const [duskProgram, delegateProgram] = await Promise.all([
    observeUpgradeableProgram(pinned.dusk),
    observeUpgradeableProgram(pinned.leverageDelegate),
  ]);

  const envelope = {
    schemaVersion: DUSK_DEPLOYMENT_SCHEMA_VERSION,
    network: apiConfig.network,
    forkSourceNetwork: apiConfig.forkSourceNetwork,
    genesisHash,
    forkId,
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
): Promise<DuskDeploymentEnvelope> {
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
    inflight = buildEnvelope()
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

  // A lagging RPC node can answer below the floor. One rebuild is enough in
  // practice; failing loudly beats stamping data with an envelope that did
  // not observe it.
  const rebuilt = await buildEnvelope();
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
