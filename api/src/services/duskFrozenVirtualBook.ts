/** Capture one confirmed bank, then quote it in an isolated non-signing worker. */
import { Connection, PublicKey } from '@solana/web3.js';
import { captureLeverageQuoteBank, quoteRpcFetch } from './duskLeverageMaximum';
import { quoteRuntimeBytes } from './duskLeverageMaximumInput';
import { prepareFrozenBookWorker, runFrozenVirtualBookProcess } from './duskFrozenVirtualBookWorker';
export { runFrozenVirtualBookProcess } from './duskFrozenVirtualBookWorker';
import type { FrozenBook } from './duskFrozenVirtualBookWorker';
import { duskApiConfig } from '../config/duskProtocol';
import { sdkForProtocol } from './virtualBook/native';
import type { DuskDeploymentEnvelope } from './duskDeploymentService';
import type { DuskVirtualBookSnapshot } from './virtualBook/virtual-book-read';
import type { VirtualBookSelection } from './duskVirtualBook';
let active = false;
const waiters: { resume: () => void }[] = [];
/** A bounded FIFO avoids starving taller books when selections refresh together. */
async function acquireCapture(signal?: AbortSignal): Promise<() => void> {
  signal?.throwIfAborted();
  if (active) {
    if (waiters.length >= 8) throw new Error('Native depth capture is busy');
    await new Promise<void>((resolveWait, reject) => {
      const waiter = { resume: () => { signal?.removeEventListener('abort', abort); resolveWait(); } };
      const abort = () => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        reject(new Error('VOB read cancelled'));
      };
      waiters.push(waiter);
      signal?.addEventListener('abort', abort, { once: true });
    });
  }
  active = true;
  return () => {
    const next = waiters.shift();
    if (next) next.resume();
    else active = false;
  };
}
export async function captureFrozenVirtualBook(snapshot: DuskVirtualBookSnapshot,selection: VirtualBookSelection,signal?: AbortSignal): Promise<FrozenBook & { observedAt: number }> {
  const release = await acquireCapture(signal);
  try {
    signal?.throwIfAborted();
    // Load the isolated runtime before observing the bank. Subsequent captures
    // reuse the process, while the engine creates a new VM for every bank.
    await prepareFrozenBookWorker(signal);
    const observedAt = Date.now(),deployment = snapshot.deployment,sdk = await sdkForProtocol();
    quoteRuntimeBytes(deployment.programId,deployment.programBinarySha256);
    const payer = deployment.programUpgradeAuthority;
    if (!payer) throw new Error('A read-only capture payer must be configured');
    const keys = [new PublicKey(selection.market),snapshot.account.baseSide.assetMint,snapshot.account.quoteSide.assetMint,
      sdk.deriveFutarchyAuthorityAddress(new PublicKey(deployment.programId))[0],sdk.DEFAULT_READONLY_PUBLIC_KEY,
      ...sdk.oracleReadAccounts(snapshot.account.oracle.policy).map(meta => meta.pubkey)];
    const rpc = new Connection(duskApiConfig().rpcUrl,{ commitment: 'confirmed',disableRetryOnRateLimit: true,
      fetch: (url,init) => quoteRpcFetch(url,{ ...init,signal: AbortSignal.any([AbortSignal.timeout(10000),...(signal ? [signal] : [])]) }) });
    const bank = await captureLeverageQuoteBank({ owner: sdk.DEFAULT_READONLY_PUBLIC_KEY.toBase58(),minimumSourceSlot: Math.max(snapshot.slot,deployment.sourceSlot) },
      keys,payer,rpc);
    signal?.throwIfAborted();
    const result = await runFrozenVirtualBookProcess(bank,selection,deployment,signal);
    return { ...result,observedAt };
  } finally { release(); }
}
