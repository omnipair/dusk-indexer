import { mock } from 'node:test';
import { AnchorProvider, Wallet } from '@coral-xyz/anchor';
import type { Connection } from '@solana/web3.js';
import * as protocol from '../config/duskProtocol';
import { createVirtualBookRuntime, sdkForProtocol } from '../services/virtualBook/native';

/** Unit fixtures exercise the pending SDK without changing the deployed pin. */
export async function createSdkTestRuntime(connection: Connection, oracle?: boolean) {
  const sdk = oracle === undefined ? await sdkForProtocol() : await (new Function(`return import('${oracle ? "@omnipair/dusk-sdk-oracle" : "@omnipair/dusk-sdk"}')`)() as Promise<typeof import('@omnipair/dusk-sdk')>);
  const pin = protocol.loadPinnedProtocol();
  const delegate = sdk.createLeverageDelegateProgram({ provider: new AnchorProvider(connection, {} as Wallet, {}) });
  const mocked = mock.method(protocol, 'loadPinnedProtocol', () => ({ ...pin,
    dusk: { ...pin.dusk, idlCanonicalSha256: protocol.sha256(protocol.canonicalJson(sdk.IDL)) },
    leverageDelegate: { ...pin.leverageDelegate, idlCanonicalSha256: protocol.sha256(protocol.canonicalJson(delegate.rawIdl)) } }));
  try { return await createVirtualBookRuntime(connection); }
  finally { mocked.mock.restore(); }
}
