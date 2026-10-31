/** Promote only finalized devnet bytes that match the reviewed local build.
 * Run after both upgrades with DUSK_RPC_URL and DUSK_SOURCE_DIR set. */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Connection, PublicKey } from '@solana/web3.js';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const source = process.env.DUSK_SOURCE_DIR;
const endpoint = process.env.DUSK_RPC_URL;
if (!source || !endpoint) throw Error('DUSK_SOURCE_DIR and DUSK_RPC_URL are required');
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const sha = data => createHash('sha256').update(data).digest('hex');
const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const protocol = resolve(root, 'protocol');
const candidateRevision = process.argv[2] ?? 'next-2026-10-31-8fadcc31';
if (!/^[A-Za-z0-9._-]{1,128}$/.test(candidateRevision)) throw Error('Invalid candidate revision');
const candidateDir = resolve(protocol, 'candidates', candidateRevision);
const candidate = json(resolve(candidateDir, 'candidate.json'));
if (candidate.revision !== candidateRevision) throw Error('Candidate directory/revision mismatch');
const old = json(resolve(protocol, 'protocol.lock.json'));
if (old.revision === candidate.revision) throw Error('Already promoted; inspect existing release instead of overwriting it');
const rpc = new Connection(endpoint, 'finalized');
if (await rpc.getGenesisHash() !== 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG') throw Error('RPC must be devnet');
const loader = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const addresses = candidate.programs.map(p => PublicKey.findProgramAddressSync([new PublicKey(p.programId).toBuffer()], loader)[0]);
const response = await rpc.getMultipleAccountsInfoAndContext(addresses, { commitment: 'finalized' });
const programs = candidate.programs.map((p, i) => {
  const local = readFileSync(resolve(source, `target/deploy/${p.name}.so`));
  const generatedIdl = readFileSync(resolve(source, `target/idl/${p.name}.json`));
  if (sha(generatedIdl) !== p.idl.sha256 || sha(readFileSync(resolve(candidateDir, p.idl.path))) !== p.idl.sha256)
    throw Error(`Generated IDL differs from the reviewed candidate: ${p.name}`);
  const account = response.value[i];
  if (!account || !account.owner.equals(loader) || account.executable || account.data.readUInt32LE(0) !== 3 || account.data[12] !== 1)
    throw Error(`Invalid finalized ProgramData: ${p.name}`);
  const slot = Number(account.data.readBigUInt64LE(4));
  const previous = old.programs.find(row => row.name === p.name);
  if (!Number.isSafeInteger(slot) || slot <= previous.deployment.deploySlot || slot > response.context.slot)
    throw Error(`No finalized new deployment: ${p.name}`);
  const authority = new PublicKey(account.data.subarray(13, 45)).toBase58();
  if (authority !== previous.deployment.upgradeAuthority) throw Error(`Upgrade authority changed: ${p.name}`);
  const allocation = account.data.subarray(45);
  if (allocation.length < local.length || !allocation.subarray(0, local.length).equals(local) || allocation.subarray(local.length).some(byte => byte !== 0))
    throw Error(`Finalized executable differs from the reviewed local build: ${p.name}`);
  return { name: p.name, programId: p.programId, binary: { path: 'on-chain (devnet)', sha256: sha(allocation) },
    idl: { path: `protocol/idl/${p.name}.json`, sha256: p.idl.sha256, canonicalSha256: p.idl.canonicalSha256 },
    deployment: { programData: addresses[i].toBase58(), deploySlot: slot, upgradeAuthority: authority, allocatedBinaryBytes: allocation.length } };
});
const deploymentSlot = Math.max(...programs.map(p => p.deployment.deploySlot));
const blockTime = await rpc.getBlockTime(deploymentSlot);
if (blockTime === null) throw Error('Deployment block time unavailable');
if (process.env.DUSK_PROMOTE_VERIFY_ONLY === 'true') {
  console.log(JSON.stringify({ revision: candidate.revision, verifiedFinalizedSlot: response.context.slot, programs }, null, 2));
  process.exit(0);
}
const archive = resolve(protocol, 'archive', old.revision);
for (const path of ['protocol.lock.json', 'compatible-deployment.json', 'devnet-price-references.json', 'idl/dusk.json', 'idl/leverage_delegate.json',
  'quote-runtime/README.md', 'quote-runtime/manifest.json', 'quote-runtime/dusk.so', 'quote-runtime/feature-set.json']) {
  const dest = resolve(archive, path); mkdirSync(dirname(dest), { recursive: true });
  if (existsSync(dest) && !readFileSync(dest).equals(readFileSync(resolve(protocol, path)))) throw Error(`Archive would overwrite history: ${path}`);
  copyFileSync(resolve(protocol, path), dest);
}
for (const p of candidate.programs) copyFileSync(resolve(candidateDir, p.idl.path), resolve(protocol, `idl/${p.name}.json`));
const lock = { ...old, revision: candidate.revision, status: 'deployed', generatedAt: new Date().toISOString(),
  source: { repository: candidate.source.repository, branch: 'feat/bounded-op-gamm', gitCommit: candidate.source.gitCommit,
    note: 'Both generated IDLs match the reviewed candidate. Finalized ProgramData executable bytes match the local release payload plus zero allocation padding.' },
  programs, sdk: { package: '@omnipair/dusk-sdk', version: candidate.sdk.version, sha256: candidate.sdk.sha256 } };
save(resolve(protocol, 'protocol.lock.json'), lock);
const dusk = programs.find(p => p.name === 'dusk');
save(resolve(protocol, 'compatible-deployment.json'), { eventRevision: lock.revision, programId: dusk.programId,
  idlCanonicalSha256: dusk.idl.canonicalSha256, sourceCommit: lock.source.gitCommit,
  deploySlot: dusk.deployment.deploySlot, binarySha256: dusk.binary.sha256, allocatedBinaryBytes: dusk.deployment.allocatedBinaryBytes });
const refs = json(resolve(protocol, 'devnet-price-references.json'));
const firstSlot = Math.max(...programs.map(p => p.deployment.deploySlot)) + 1;
save(resolve(protocol, 'devnet-price-references.json'), { ...refs, idlSha256: dusk.idl.canonicalSha256, protocolRevision: lock.revision,
  effectiveFrom: new Date(blockTime * 1000).toISOString() });
const payload = readFileSync(resolve(source, 'target/deploy/dusk.so'));
copyFileSync(resolve(source, 'target/deploy/dusk.so'), resolve(protocol, 'quote-runtime/dusk.so'));
const priorRuntime = json(resolve(protocol, 'quote-runtime/manifest.json'));
save(resolve(protocol, 'quote-runtime/manifest.json'), { ...priorRuntime, programBinarySha256: dusk.binary.sha256,
  payloadSha256: sha(payload), payloadBytes: payload.length, allocatedBinaryBytes: dusk.deployment.allocatedBinaryBytes,
  sourceCommit: lock.source.gitCommit });
const constants = resolve(root, 'indexer/crates/dusk-ingestion/src/lib.rs');
let code = readFileSync(constants, 'utf8');
const replace = (name, value) => { const pattern = new RegExp(`(pub const ${name}: &str =\\s*)"[^"]+";`); if (!pattern.test(code)) throw Error(`Missing Rust pin ${name}`); code = code.replace(pattern, `$1"${value}";`); };
replace('PROTOCOL_REVISION', lock.revision);
for (const [prefix, p] of [['DUSK', dusk], ['LEVERAGE_DELEGATE', programs.find(p => p.name === 'leverage_delegate')]]) {
  replace(`${prefix}_IDL_RAW_SHA256`, p.idl.sha256); replace(`${prefix}_IDL_SHA256`, p.idl.canonicalSha256);
}
writeFileSync(constants, code);
console.log(JSON.stringify({ revision: lock.revision, verifiedFinalizedSlot: response.context.slot, firstSlot, programs }, null, 2));
