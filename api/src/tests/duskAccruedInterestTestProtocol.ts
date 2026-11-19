/** Isolated, synthetic layout-19 banks for candidate arithmetic tests.
 * No deployment, binary, SDK publication or active-pin promotion is claimed.
 * Import before services/fixtures: Node runs each test file in its own process.
 */
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { PublicKey } from '@solana/web3.js';
import { canonicalJson, sha256 } from '../config/duskProtocol';

if (!process.env.NODE_TEST_CONTEXT) throw new Error('Candidate fixture protocol is restricted to Node test workers');
const candidateRoot = resolve(__dirname, '../../../protocol/candidates/next-2026-11-15-accrued-interest');
const candidate = JSON.parse(readFileSync(resolve(candidateRoot, 'candidate.json'), 'utf8'));
if (candidate.status !== 'undeployed' || candidate.marketLayoutVersion !== 19) throw new Error('Unexpected candidate fixture schema');
const root = mkdtempSync(resolve(tmpdir(), 'dusk-layout19-test-'));
mkdirSync(resolve(root, 'idl'));
process.once('exit', () => rmSync(root, { recursive: true, force: true }));
const programs = candidate.programs.map((entry: { name: string; programId: string; idl: { path: string; sha256: string; canonicalSha256: string } }, index: number) => {
  const bytes = readFileSync(resolve(candidateRoot, entry.idl.path));
  const idl = JSON.parse(bytes.toString());
  if (sha256(bytes) !== entry.idl.sha256 || sha256(canonicalJson(idl)) !== entry.idl.canonicalSha256 || idl.address !== entry.programId)
    throw new Error('Candidate fixture IDL differs from its reviewed hashes');
  writeFileSync(resolve(root, entry.idl.path), bytes);
  return {
    name: entry.name, programId: entry.programId, idl: { ...entry.idl, path: `protocol/${entry.idl.path}` },
    // Explicitly synthetic metadata satisfies pin parsing; no ELF exists and
    // production runtime/deployment verification cannot pass with this lock.
    binary: { sha256: sha256(`synthetic-fixture-no-deployed-binary:${entry.name}`) },
    deployment: { programData: PublicKey.findProgramAddressSync([new PublicKey(entry.programId).toBuffer()],
      new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111'))[0].toBase58(),
      deploySlot: index + 1, upgradeAuthority: null, allocatedBinaryBytes: 4 },
  };
});
writeFileSync(resolve(root, 'protocol.lock.json'), JSON.stringify({
  status: 'synthetic-test-fixture', revision: 'test-only-layout19', programs,
  cluster: { name: 'mainnet-beta', genesisHash: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d' },
}));
process.env.DUSK_PROTOCOL_DIR = root;
