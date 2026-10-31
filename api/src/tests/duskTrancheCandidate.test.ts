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
  '../../../protocol/candidates/next-2026-11-01-96c1fba5',
);
const candidate = JSON.parse(
  readFileSync(resolve(root, 'candidate.json'), 'utf8'),
);

test('junior tranche candidate remains immutable and inactive', async () => {
  assert.equal(candidate.schemaVersion, 'dusk-protocol-candidate.v1');
  assert.equal(candidate.status, 'undeployed');
  assert.equal(candidate.revision, 'next-2026-11-01-96c1fba5');
  assert.equal(
    candidate.source.gitCommit,
    '96c1fba5f803270c292a5a7821d0efa4708ae6bb',
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
  assert.equal(active.revision, 'next-2026-10-31-layouts');
  assert.notEqual(
    active.dusk.idlCanonicalSha256,
    candidate.programs[0].idl.canonicalSha256,
  );

  const selected = await sdkForProtocol({
    ...active,
    dusk: {
      ...active.dusk,
      idlCanonicalSha256: candidate.programs[0].idl.canonicalSha256,
    },
  });
  assert.equal(
    sha256(canonicalJson(selected.IDL)),
    candidate.programs[0].idl.canonicalSha256,
  );
  await assert.rejects(
    sdkForProtocol({
      ...active,
      dusk: { ...active.dusk, idlCanonicalSha256: 'f'.repeat(64) },
    }),
    /differs/,
  );
});
