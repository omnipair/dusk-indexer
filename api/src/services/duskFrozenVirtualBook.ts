/** Capture one confirmed bank, then quote it in an isolated non-signing worker. */
import { Connection, PublicKey } from '@solana/web3.js';
import { fork } from 'node:child_process';
import { resolve } from 'node:path';
import { captureLeverageQuoteBank, quoteRpcFetch } from './duskLeverageMaximum';
import { quoteRuntimeBytes, FrozenLeverageBank } from './duskLeverageMaximumInput';
import { duskApiConfig } from '../config/duskProtocol';
import { sdkForProtocol } from './virtualBook/native';
import type { DuskDeploymentEnvelope } from './duskDeploymentService';
import type { DuskVirtualBookSnapshot } from './virtualBook/virtual-book-read';
import type { VirtualBookSelection } from './duskVirtualBook';
import type { VirtualBookView } from './virtualBook/virtual-book-view-model';

interface FrozenBook { book: VirtualBookView; slot: number; firstQuoteSlot: number; baseMint: string; quoteMint: string; baseDecimals: number; quoteDecimals: number }
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
export function runFrozenVirtualBookProcess(bank: FrozenLeverageBank,selection: VirtualBookSelection,deployment: DuskDeploymentEnvelope,signal?: AbortSignal): Promise<FrozenBook> {
  signal?.throwIfAborted();
  return new Promise((resolveBook,reject) => {
    // No runtime provider keys, database passwords or AWS task credentials are
    // passed to the native worker. Its input is public captured account bytes.
    const env = Object.fromEntries(['NODE_ENV','DUSK_PROTOCOL_DIR','DUSK_CLUSTER','DUSK_PROTOCOL_REVISION','DUSK_PROGRAM_ID','DUSK_IDL_HASH']
      .flatMap(key => process.env[key] === undefined ? [] : [[key,process.env[key]!]]));
    const worker = fork(resolve(__dirname,'duskFrozenVirtualBookProcess.js'),[],{ stdio: ['ignore','ignore','ignore','ipc'],env,execArgv: ['--max-old-space-size=256'] });
    let settled = false;
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort',abort); };
    const finish = (error?: Error,value?: FrozenBook) => {
      if (settled) return; settled=true; cleanup(); worker.kill('SIGKILL');
      if (error) reject(error); else resolveBook(value!);
    };
    const timer = setTimeout(() => finish(new Error('Native depth capture timed out')),10000);
    const abort = () => finish(new Error('VOB read cancelled'));
    signal?.addEventListener('abort',abort,{ once: true });
    worker.once('message',(value: FrozenBook & { kind: string }) => {
      if (value.kind!=='book' || value.slot!==bank.slot || value.firstQuoteSlot!==bank.slot || value.book?.market!==selection.market)
        finish(new Error('Native depth capture unavailable'));
      else finish(undefined,value);
    });
    worker.once('error',() => finish(new Error('Native depth worker failed')));
    worker.once('exit',() => finish(new Error('Native depth worker stopped')));
    worker.send({ bank,selection,deployment },error => { if (error) finish(new Error('Native depth capture unavailable')); });
    if (signal?.aborted) abort();
  });
}
