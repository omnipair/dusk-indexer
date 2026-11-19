/** Read-only chain capture followed by a local, atomic-identity pin promotion.
 * Requires the tested production bundle and the exact npm-published SDK.
 * Does not sign, deploy, migrate a database, or publish anything.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Connection, PublicKey } from '@solana/web3.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const [sourceArg, bundleArg, sdkArg, revision] = process.argv.slice(2);
assert.ok(sourceArg && bundleArg && sdkArg && /^mainnet-\d{4}-\d{2}-\d{2}$/.test(revision),
  'Expected CLEAN_CORE_CHECKOUT NORMAL_RELEASE_BUNDLE PUBLISHED_SDK_TGZ REVISION');
const source = resolve(sourceArg), sdk = resolve(sdkArg);
const { readBundle, verifyOnChain, assertProgramBytes, decodeIdl, idlHash, CONFIG, LOADER, git } =
  await import(pathToFileURL(resolve(source, 'scripts/release/artifacts.mjs')));
const bundle = readBundle(resolve(bundleArg));
assert.equal(git('rev-parse', 'HEAD'), bundle.manifest.sourceCommit);
assert.equal(git('status', '--porcelain', '--untracked-files=no'), '', 'Core checkout must be clean');
git('merge-base', '--is-ancestor', bundle.manifest.sourceCommit, 'origin/main');
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const encode = value => JSON.stringify(value, null, 2) + '\n';
const save = (path, value) => writeFileSync(path, encode(value));
const packed = path => execFileSync('tar', ['-xOf', sdk, path]);
const pkg = JSON.parse(packed('package/package.json').toString());
assert.equal(pkg.name, '@omnipair/dusk-sdk');
assert.equal(pkg.version, bundle.manifest.version);
assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
const registry = await fetch(`https://registry.npmjs.org/@omnipair%2Fdusk-sdk/${pkg.version}`, { signal: AbortSignal.timeout(30_000) });
assert.ok(registry.ok, 'Published npm version metadata is unavailable');
const published = await registry.json();
assert.equal(published.name, pkg.name); assert.equal(published.version, pkg.version);
const dist = published.dist;
assert.equal(dist.integrity, 'sha512-' + createHash('sha512').update(readFileSync(sdk)).digest('base64'));
const protocol = resolve(root, 'protocol'), old = json(resolve(protocol, 'protocol.lock.json'));
assert.equal(old.cluster.name, 'mainnet-beta');
assert.notEqual(old.revision, revision, 'Already promoted; inspect artifacts before rerunning');
assert.ok(process.env.DUSK_RPC_URL, 'DUSK_RPC_URL is required');
const rpc = new Connection(process.env.DUSK_RPC_URL, 'finalized');
assert.equal(await rpc.getGenesisHash(), CONFIG.genesisHash);
const before = await verifyOnChain(rpc, bundle, true);
const payloads = new Map(), idls = new Map(), programs = [];
for (const [name, entry] of Object.entries(bundle.manifest.programs)) {
  const program = new PublicKey(entry.id), programData = PublicKey.findProgramAddressSync([program.toBuffer()], LOADER)[0];
  const base = PublicKey.findProgramAddressSync([], program)[0];
  const idlAddress = await PublicKey.createWithSeed(base, 'anchor:idl', program);
  const observed = await rpc.getMultipleAccountsInfoAndContext([program, programData, idlAddress], { commitment: 'finalized' });
  const [executable, data, rawIdl] = observed.value;
  assert.ok(executable?.executable && executable.owner.equals(LOADER) && !data?.executable && rawIdl);
  assert.equal(executable.data.readUInt32LE(0), 2);
  assert.ok(new PublicKey(executable.data.subarray(4, 36)).equals(programData));
  assert.ok(data.owner.equals(LOADER) && rawIdl.owner.equals(program));
  assert.equal(data.data.readUInt32LE(0), 3); assert.equal(data.data[12], 1);
  const authority = new PublicKey(data.data.subarray(13, 45)).toBase58();
  assert.equal(authority, CONFIG.deployer);
  assertProgramBytes(data.data, readFileSync(resolve(bundle.directory, entry.binary.file)));
  const idlBytes = readFileSync(resolve(bundle.directory, entry.idl.file)), idl = JSON.parse(idlBytes.toString());
  const decoded = decodeIdl(rawIdl.data);
  assert.equal(decoded.authority, CONFIG.idlAuthority); assert.equal(idlHash(decoded.idl), idlHash(idl));
  const shipped = JSON.parse(packed(name === 'dusk' ? 'package/dist/idl_v2.json' : 'package/dist/idl_delegate.json').toString());
  assert.equal(idlHash(shipped), idlHash(idl));
  const payload = data.data.subarray(45), slot = Number(data.data.readBigUInt64LE(4));
  assert.ok(Number.isSafeInteger(slot) && slot <= observed.context.slot);
  const prior = old.programs.find(row => row.name === name);
  assert.ok(prior && slot > prior.deployment.deploySlot, 'Both programs must have a finalized successor deployment');
  payloads.set(name, payload); idls.set(name, idlBytes);
  programs.push({ name, programId: entry.id, binary: { path: 'on-chain (mainnet-beta)', sha256: sha(payload) },
    idl: { path: `protocol/idl/${name}.json`, sha256: sha(idlBytes), canonicalSha256: idlHash(idl) },
    deployment: { programData: programData.toBase58(), deploySlot: slot, upgradeAuthority: authority, allocatedBinaryBytes: payload.length } });
}
const lastSlot = Math.max(...programs.map(row => row.deployment.deploySlot));
const blockTime = await rpc.getBlockTime(lastSlot); assert.ok(blockTime !== null);
const after = await verifyOnChain(rpc, bundle, true);
assert.deepEqual(after.programs.map(row => [row.name, row.deploymentSlot]), before.programs.map(row => [row.name, row.deploymentSlot]), 'Deployment changed during capture');
const archived = ['protocol.lock.json', 'compatible-deployment.json', 'mainnet-price-references.json', 'idl/dusk.json', 'idl/leverage_delegate.json',
  'quote-runtime/README.md', 'quote-runtime/manifest.json', 'quote-runtime/dusk.so', 'quote-runtime/feature-set.json'];
const archive = resolve(protocol, 'archive', old.revision);
// Validate every existing immutable file before the first write.
for (const path of archived) {
  const dest = resolve(archive, path), bytes = readFileSync(resolve(protocol, path));
  if (existsSync(dest)) assert.ok(readFileSync(dest).equals(bytes), `Archive differs: ${path}`);
}
for (const path of archived) {
  const dest = resolve(archive, path); mkdirSync(dirname(dest), { recursive: true }); copyFileSync(resolve(protocol, path), dest);
}
for (const [name, bytes] of idls) writeFileSync(resolve(protocol, `idl/${name}.json`), bytes);
const lock = { ...old, revision, status: 'deployed', generatedAt: new Date().toISOString(),
  source: { repository: CONFIG.repository, branch: 'main', gitCommit: bundle.manifest.sourceCommit,
    note: 'Finalized executable payloads, zero padding, both IDLs and deployer authorities match the exact tested production bundle. Historical revisions retain their own identity.' },
  programs, sdk: { package: pkg.name, version: pkg.version, sha256: sha(readFileSync(sdk)) } };
save(resolve(protocol, 'protocol.lock.json'), lock);
const dusk = programs.find(row => row.name === 'dusk'), delegate = programs.find(row => row.name === 'leverage_delegate');
const compatible = row => ({ programId: row.programId, idlCanonicalSha256: row.idl.canonicalSha256, sourceCommit: bundle.manifest.sourceCommit,
  deploySlot: row.deployment.deploySlot, binarySha256: row.binary.sha256, allocatedBinaryBytes: row.deployment.allocatedBinaryBytes });
save(resolve(protocol, 'compatible-deployment.json'), { eventRevision: revision, ...compatible(dusk), leverageDelegate: compatible(delegate) });
const refs = json(resolve(protocol, 'mainnet-price-references.json'));
save(resolve(protocol, 'mainnet-price-references.json'), { ...refs, programId: dusk.programId, idlSha256: dusk.idl.canonicalSha256, protocolRevision: revision, effectiveFrom: new Date(blockTime * 1000).toISOString() });
writeFileSync(resolve(protocol, 'quote-runtime/dusk.so'), payloads.get('dusk'));
const features = readFileSync(resolve(protocol, 'quote-runtime/feature-set.json'));
save(resolve(protocol, 'quote-runtime/manifest.json'), { schemaVersion: 'dusk-quote-runtime.v1', programId: dusk.programId,
  programBinarySha256: dusk.binary.sha256, payloadSha256: sha(payloads.get('dusk')), payloadBytes: payloads.get('dusk').length,
  allocatedBinaryBytes: dusk.deployment.allocatedBinaryBytes, sourceCommit: bundle.manifest.sourceCommit, featureSetSha256: sha(features) });
const constants = resolve(root, 'indexer/crates/dusk-ingestion/src/lib.rs');
let code = readFileSync(constants, 'utf8');
const replace = (name, value) => { const pattern = new RegExp(`(pub const ${name}: &str =\\s*)"[^"]+";`); assert.ok(pattern.test(code), `Missing Rust pin ${name}`); code = code.replace(pattern, `$1"${value}";`); };
replace('PROTOCOL_REVISION', revision);
for (const [prefix, row] of [['DUSK', dusk], ['LEVERAGE_DELEGATE', delegate]]) {
  replace(`${prefix}_PROGRAM_ID`, row.programId); replace(`${prefix}_IDL_RAW_SHA256`, row.idl.sha256); replace(`${prefix}_IDL_SHA256`, row.idl.canonicalSha256);
}
writeFileSync(constants, code);
const infra = resolve(root, 'deploy/aws/infra/lib/services.ts');
const previousInfra = readFileSync(infra, 'utf8');
assert.ok(previousInfra.includes(`DUSK_PROTOCOL_REVISION: '${old.revision}'`));
writeFileSync(infra, previousInfra.replace(`DUSK_PROTOCOL_REVISION: '${old.revision}'`, `DUSK_PROTOCOL_REVISION: '${revision}'`)
  .replace(`DUSK_IDL_HASH: '${old.programs.find(row => row.name === 'dusk').idl.canonicalSha256}'`, `DUSK_IDL_HASH: '${dusk.idl.canonicalSha256}'`));
console.log(JSON.stringify({ revision, sourceCommit: bundle.manifest.sourceCommit, replayFirstSlot: lastSlot + 1, sdkVersion: pkg.version, programs }, null, 2));
