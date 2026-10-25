import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { Connection } from '@solana/web3.js';
import * as protocol from '../config/duskProtocol';
import { createVirtualBookRuntime } from '../services/virtualBook/native';

test('a source SDK cannot start a runtime under a different deployed IDL pin', async () => {
  const pin = protocol.loadPinnedProtocol();
  const mocked = mock.method(protocol, 'loadPinnedProtocol', () => ({ ...pin,
    dusk: { ...pin.dusk, idlCanonicalSha256: '0'.repeat(64) } }));
  try { await assert.rejects(createVirtualBookRuntime(new Connection('http://localhost:8899')), /SDK IDL differs from the pinned deployment/); }
  finally { mocked.mock.restore(); }
});
