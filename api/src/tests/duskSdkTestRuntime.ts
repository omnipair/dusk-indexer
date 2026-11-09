import type { Connection } from '@solana/web3.js';
import { createVirtualBookRuntime } from '../services/virtualBook/native';

/** Fixtures use the same verified published SDK and protocol pin as the API. */
export async function createSdkTestRuntime(connection: Connection) {
  return createVirtualBookRuntime(connection);
}
