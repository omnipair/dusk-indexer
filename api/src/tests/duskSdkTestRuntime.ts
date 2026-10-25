import { mock } from 'node:test';
import type { Connection } from '@solana/web3.js';
import * as protocol from '../config/duskProtocol';
import { createVirtualBookRuntime } from '../services/virtualBook/native';

/** Unit fixtures exercise the pending SDK without changing the deployed pin. */
export async function createSdkTestRuntime(connection: Connection) {
  const sdk = await (new Function("return import('@omnipair/dusk-sdk')")() as Promise<typeof import('@omnipair/dusk-sdk')>);
  const pin = protocol.loadPinnedProtocol();
  const mocked = mock.method(protocol, 'loadPinnedProtocol', () => ({ ...pin,
    dusk: { ...pin.dusk, idlCanonicalSha256: protocol.sha256(protocol.canonicalJson(sdk.IDL)) } }));
  try { return await createVirtualBookRuntime(connection); }
  finally { mocked.mock.restore(); }
}
