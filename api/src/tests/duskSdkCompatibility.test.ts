import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { Connection } from '@solana/web3.js';
import * as protocol from '../config/duskProtocol';
import { createVirtualBookRuntime } from '../services/virtualBook/native';

test('the vendored SDK starts under the verified active deployment IDL pin', async () => {
  const { dusk } = await createVirtualBookRuntime(new Connection('http://localhost:8899'));
  const pin = protocol.loadPinnedProtocol();
  assert.equal(dusk.program.programId.toBase58(), pin.dusk.programId);
  assert.equal(protocol.sha256(protocol.canonicalJson(dusk.program.rawIdl)), pin.dusk.idlCanonicalSha256);
});

test('a source SDK cannot start a runtime under a different deployed IDL pin', async () => {
  const pin = protocol.loadPinnedProtocol();
  const mocked = mock.method(protocol, 'loadPinnedProtocol', () => ({ ...pin,
    dusk: { ...pin.dusk, idlCanonicalSha256: '0'.repeat(64) } }));
  try { await assert.rejects(createVirtualBookRuntime(new Connection('http://localhost:8899')), /SDK IDL differs from the pinned deployment/); }
  finally { mocked.mock.restore(); }
});
