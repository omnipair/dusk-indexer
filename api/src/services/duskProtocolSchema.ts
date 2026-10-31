import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Idl } from '@coral-xyz/anchor';
import type { IdlField } from '@coral-xyz/anchor/dist/cjs/idl';
import { loadPinnedProtocol, sha256 } from '../config/duskProtocol';

let verified: { path: string; hash: string; idl: Idl } | undefined;

/** Schema-dependent bounds follow the verified pin, not a particular SDK build.
 * Like loadPinnedProtocol, verify once for each process/path/hash combination. */
export function pinnedDuskIdl(): Idl {
  const pin = loadPinnedProtocol();
  const root = process.env.DUSK_PROTOCOL_DIR?.trim() || resolve(__dirname, '../../../protocol');
  const path = resolve(root, 'idl/dusk.json');
  if (verified?.path === path && verified.hash === pin.dusk.idlRawSha256) return verified.idl;
  const bytes = readFileSync(path);
  if (sha256(bytes) !== pin.dusk.idlRawSha256) throw new Error('Dusk schema bytes differ from the protocol pin');
  const idl = JSON.parse(bytes.toString()) as Idl;
  verified = { path, hash: pin.dusk.idlRawSha256, idl };
  return idl;
}

export function marketLayoutVersion(): number {
  const constant = pinnedDuskIdl().constants?.find(row => row.name === 'MARKET_LAYOUT_VERSION');
  const version = Number(constant?.value);
  if (!Number.isInteger(version) || version < 1 || version > 255) throw new Error('Invalid pinned market layout version');
  return version;
}

export function governanceFamilyCount(idl: Idl = pinnedDuskIdl()): number {
  const proposal = idl.types?.find(row => row.name === 'ParameterProposal' || row.name === 'parameterProposal');
  const fields = proposal?.type.kind === 'struct' ? proposal.type.fields ?? [] : [];
  const revisions = fields.find((row): row is IdlField => typeof row === 'object' && 'name' in row
    && (row.name === 'family_revisions' || row.name === 'familyRevisions'));
  const length = revisions && typeof revisions.type === 'object' && 'array' in revisions.type ? revisions.type.array[1] : null;
  if (length !== 7 && length !== 8) throw new Error('Unsupported governance revision layout');
  return length;
}
