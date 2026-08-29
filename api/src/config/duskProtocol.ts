/**
 * Pinned Dusk protocol artifacts.
 *
 * The API serves the same deployment identity the ingestion daemon verifies,
 * read from the same `protocol/` directory: one lock file, one IDL per
 * program. Loading fails closed — a lock that disagrees with the IDL bytes on
 * disk means the vendored artifacts were half-updated, and an API that served
 * an envelope from a half-updated pin would attest to a deployment nobody
 * built.
 */

import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { resolve } from 'path';

export const DUSK_DEPLOYMENT_SCHEMA_VERSION = 'dusk-deployment.v1';

/** The envelope commitment the web app pins; not the daemon's ingestion one. */
export const DUSK_DEPLOYMENT_COMMITMENT = 'confirmed';

export interface DuskPinnedProgram {
  readonly name: string;
  readonly programId: string;
  readonly binarySha256: string;
  /** SHA-256 of the IDL file bytes, as pinned by the lock. */
  readonly idlRawSha256: string;
  /** SHA-256 of the recursively key-sorted canonical JSON. */
  readonly idlCanonicalSha256: string;
}

export interface DuskPinnedProtocol {
  readonly revision: string;
  readonly cluster: string;
  readonly genesisHash: string;
  readonly dusk: DuskPinnedProgram;
  readonly leverageDelegate: DuskPinnedProgram;
}

/** Recursive key-sorted JSON, so a digest is independent of key order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error('Cannot canonicalize an undefined JSON value');
  }
  return serialized;
}

export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function protocolDir(): string {
  const configured = process.env.DUSK_PROTOCOL_DIR?.trim();
  if (configured) return resolve(configured);
  // dist/config → api → repository root.
  return resolve(__dirname, '../../../protocol');
}

interface LockProgram {
  name?: unknown;
  programId?: unknown;
  binary?: { sha256?: unknown };
  idl?: { path?: unknown; sha256?: unknown };
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`protocol.lock.json is missing ${field}`);
  }
  return value;
}

function loadProgram(entry: LockProgram, root: string): DuskPinnedProgram {
  const name = requireString(entry.name, 'programs[].name');
  const programId = requireString(entry.programId, `programs[${name}].programId`);
  const binarySha256 = requireString(
    entry.binary?.sha256,
    `programs[${name}].binary.sha256`,
  );
  const idlPath = requireString(entry.idl?.path, `programs[${name}].idl.path`);
  const idlRawSha256 = requireString(
    entry.idl?.sha256,
    `programs[${name}].idl.sha256`,
  );

  // The lock records the path relative to the repository root.
  const absoluteIdlPath = resolve(root, '..', idlPath);
  const raw = readFileSync(absoluteIdlPath, 'utf8');
  const observedRawSha256 = sha256(raw);
  if (observedRawSha256 !== idlRawSha256) {
    throw new Error(
      `IDL ${idlPath} hashes to ${observedRawSha256} but the lock pins ${idlRawSha256}`,
    );
  }

  const parsed = JSON.parse(raw) as { address?: unknown };
  const declared = typeof parsed.address === 'string' ? parsed.address : '';
  if (declared !== programId) {
    throw new Error(
      `IDL ${idlPath} declares ${declared || 'no program address'}; the lock pins ${programId}`,
    );
  }

  return {
    name,
    programId,
    binarySha256,
    idlRawSha256,
    idlCanonicalSha256: sha256(canonicalJson(parsed)),
  };
}

let cached: DuskPinnedProtocol | undefined;

export function loadPinnedProtocol(): DuskPinnedProtocol {
  if (cached) return cached;

  const root = protocolDir();
  const lockPath = resolve(root, 'protocol.lock.json');
  const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as {
    revision?: unknown;
    cluster?: { name?: unknown; genesisHash?: unknown };
    programs?: LockProgram[];
  };

  const programs = Array.isArray(lock.programs) ? lock.programs : [];
  const byName = new Map(
    programs
      .filter((entry) => typeof entry.name === 'string')
      .map((entry) => [entry.name as string, entry]),
  );

  const duskEntry = byName.get('dusk');
  const delegateEntry = byName.get('leverage_delegate');
  if (!duskEntry || !delegateEntry) {
    throw new Error(
      'protocol.lock.json must pin both the dusk and leverage_delegate programs',
    );
  }

  cached = {
    revision: requireString(lock.revision, 'revision'),
    cluster: requireString(lock.cluster?.name, 'cluster.name'),
    genesisHash: requireString(lock.cluster?.genesisHash, 'cluster.genesisHash'),
    dusk: loadProgram(duskEntry, root),
    leverageDelegate: loadProgram(delegateEntry, root),
  };
  return cached;
}

export interface DuskApiConfig {
  readonly network: string;
  readonly forkSourceNetwork: string;
  readonly rpcUrl: string;
  readonly forkNamespace: string;
  readonly buildRevision: string;
  readonly envelopeCacheTtlMs: number;
}

export function duskApiConfig(): DuskApiConfig {
  const pinned = loadPinnedProtocol();
  const network = process.env.DUSK_CLUSTER?.trim() || pinned.cluster;
  const rpcUrl = process.env.DUSK_RPC_URL?.trim();
  if (!rpcUrl) throw new Error('DUSK_RPC_URL is required');

  const ttlRaw = process.env.DUSK_ENVELOPE_CACHE_TTL_MS?.trim();
  const ttl = ttlRaw ? Number(ttlRaw) : 15_000;
  if (!Number.isSafeInteger(ttl) || ttl < 0) {
    throw new Error('DUSK_ENVELOPE_CACHE_TTL_MS must be a nonnegative integer');
  }

  return {
    network,
    // A real cluster is not a fork of anything; it is its own source.
    forkSourceNetwork: process.env.DUSK_FORK_SOURCE_NETWORK?.trim() || network,
    rpcUrl,
    forkNamespace: process.env.DUSK_FORK_NAMESPACE?.trim() || `dusk-${network}`,
    buildRevision:
      process.env.DUSK_BUILD_REVISION?.trim() ||
      process.env.RAILWAY_GIT_COMMIT_SHA?.trim() ||
      `${pinned.revision}-unversioned`,
    envelopeCacheTtlMs: ttl,
  };
}
