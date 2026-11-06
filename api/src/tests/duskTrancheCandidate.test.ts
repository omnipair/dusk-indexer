import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  canonicalJson,
  loadPinnedProtocol,
  loadProtocolAt,
  sha256,
} from '../config/duskProtocol';
import { sdkForProtocol } from '../services/virtualBook/native';

const root = resolve(
  __dirname,
  '../../../protocol/candidates/devnet-2026-11-01-tranches-fresh',
);
const candidate = JSON.parse(
  readFileSync(resolve(root, 'candidate.json'), 'utf8'),
);

test('prior junior tranche promotion bundle remains verifiable after the next activation', async () => {
  assert.equal(candidate.schemaVersion, 'dusk-protocol-candidate.v1');
  assert.equal(candidate.status, 'promoted');
  assert.equal(candidate.revision, 'devnet-2026-11-01-tranches-fresh');
  assert.equal(
    candidate.source.gitCommit,
    'c8ef8e32302ee88ce99c1244d5605892ca61aa80',
  );

  for (const program of candidate.programs) {
    const bytes = readFileSync(resolve(root, program.idl.path));
    assert.equal(sha256(bytes), program.idl.sha256);
    assert.equal(
      sha256(canonicalJson(JSON.parse(bytes.toString()))),
      program.idl.canonicalSha256,
    );
    assert.equal(program.deployment, undefined);
    assert.equal(program.binary, undefined);
  }

  const archive = readFileSync(resolve(root, '../../..', candidate.sdk.path));
  assert.equal(sha256(archive), candidate.sdk.sha256);
  assert.throws(() => loadProtocolAt(root), /protocol.lock/);

  const active = loadPinnedProtocol();
  assert.notEqual(active.revision, candidate.revision);
  assert.notEqual(
    active.dusk.idlCanonicalSha256,
    candidate.programs[0].idl.canonicalSha256,
  );
  assert.notEqual(
    active.leverageDelegate.idlCanonicalSha256,
    candidate.programs[1].idl.canonicalSha256,
  );

  await assert.rejects(sdkForProtocol({ ...active, dusk: { ...active.dusk,
    idlCanonicalSha256: candidate.programs[0].idl.canonicalSha256,
  } }), /differs/, 'a historical decoder cannot authorize current SDK execution');
  await assert.rejects(
    sdkForProtocol({
      ...active,
      dusk: { ...active.dusk, idlCanonicalSha256: 'f'.repeat(64) },
    }),
    /differs/,
  );
});
