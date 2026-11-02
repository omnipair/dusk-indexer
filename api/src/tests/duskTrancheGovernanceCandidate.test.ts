import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Idl } from '@coral-xyz/anchor';

import { canonicalJson, loadPinnedProtocol, loadProtocolAt, sha256 } from '../config/duskProtocol';
import { governanceFamilyCount, marketAccountLayout, marketLayoutVersion } from '../services/duskProtocolSchema';
import { sdkForProtocol } from '../services/virtualBook/native';

const root = resolve(__dirname,'../../../protocol/candidates/next-2026-11-02-9e573ca3');
const candidate = JSON.parse(readFileSync(resolve(root,'candidate.json'),'utf8'));
const idl = JSON.parse(readFileSync(resolve(root,'idl/dusk.json'),'utf8')) as Idl;
const promotedRoot = resolve(__dirname,'../../../protocol/candidates/devnet-2026-11-02-governable-tranches');
const promoted = JSON.parse(readFileSync(resolve(promotedRoot,'candidate.json'),'utf8'));

test('reviewed candidate stays immutable after the verified release is promoted',async () => {
  assert.equal(candidate.schemaVersion,'dusk-protocol-candidate.v1');
  assert.equal(candidate.status,'undeployed');
  assert.equal(candidate.source.gitCommit,'9e573ca3bab7d870db007a649e471c1aadb8f7e5');
  for (const program of candidate.programs) {
    const bytes=readFileSync(resolve(root,program.idl.path));
    assert.equal(sha256(bytes),program.idl.sha256);
    assert.equal(sha256(canonicalJson(JSON.parse(bytes.toString()))),program.idl.canonicalSha256);
    assert.equal(program.deployment,undefined);
    assert.equal(program.binary,undefined);
  }
  assert.equal(sha256(readFileSync(resolve(root,'../../..',candidate.sdk.path))),candidate.sdk.sha256);
  assert.throws(() => loadProtocolAt(root),/protocol.lock/);
  const active=loadPinnedProtocol();
  assert.equal(promoted.status,'promoted');
  assert.equal(promoted.revision,active.revision);
  assert.equal(promoted.source.gitCommit,'bd980852fa743be609896109307f4084732eddf7');
  assert.equal(active.dusk.idlCanonicalSha256,candidate.programs[0].idl.canonicalSha256);
  const sdk=await sdkForProtocol(active);
  assert.equal(sha256(canonicalJson(sdk.IDL)),candidate.programs[0].idl.canonicalSha256);
});

test('candidate carries layout 10, nine governance families and junior metadata input',() => {
  assert.equal(marketLayoutVersion(idl),10);
  assert.equal(governanceFamilyCount(idl),9);
  assert.deepEqual(marketAccountLayout(idl),marketAccountLayout());
  const args=idl.types?.find(row=>row.name==='InitializeJuniorArgs');
  assert.equal(args?.type.kind,'struct');
  const metadata=(args?.type.kind==='struct' ? args.type.fields ?? [] : []).find(row=>
    typeof row==='object' && 'name' in row && row.name==='metadata');
  assert.ok(metadata,'initialize_junior must carry validated metadata');
});
