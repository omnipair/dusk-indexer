/** One warm, isolated process; no VM or financial snapshot survives a request. */
import { fork, ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { FrozenLeverageBank } from './duskLeverageMaximumInput';
import type { DuskDeploymentEnvelope } from './duskDeploymentService';
import type { VirtualBookSelection } from './duskVirtualBook';
import type { VirtualBookView } from './virtualBook/virtual-book-view-model';

export interface FrozenBook { book: VirtualBookView; slot: number; firstQuoteSlot: number; baseMint: string; quoteMint: string; baseDecimals: number; quoteDecimals: number }
interface Worker { child: ChildProcess; ready: Promise<void>; dead: boolean; idle?: NodeJS.Timeout }
let parked: Worker | undefined;
function retire(worker: Worker) {
  worker.dead = true;
  clearTimeout(worker.idle);
  if (parked === worker) parked = undefined;
  worker.child.kill('SIGKILL');
}
function spawnWorker(): Worker {
  // Provider, database and AWS credentials never enter this process.
  const env = Object.fromEntries(['NODE_ENV','DUSK_PROTOCOL_DIR','DUSK_CLUSTER','DUSK_PROTOCOL_REVISION','DUSK_PROGRAM_ID','DUSK_IDL_HASH']
    .flatMap(key => process.env[key] === undefined ? [] : [[key,process.env[key]!]]));
  const child = fork(resolve(__dirname,'duskFrozenVirtualBookProcess.js'),[],{
    stdio: ['ignore','ignore','ignore','ipc'],env,execArgv: ['--max-old-space-size=256'],
  });
  const worker: Worker = { child,dead: false,ready: Promise.resolve() };
  worker.ready = new Promise<void>((resolveReady,reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer);
      child.removeListener('message',message);
      child.removeListener('error',failed);
      child.removeListener('exit',failed);
      if (error) { retire(worker); reject(error); } else resolveReady();
    };
    const message = (value: { kind?: string }) => value?.kind === 'ready'
      ? finish() : finish(new Error('Native depth worker failed'));
    const failed = () => finish(new Error('Native depth worker stopped'));
    const timer = setTimeout(() => finish(new Error('Native depth worker startup timed out')),10000);
    child.once('message',message);
    child.once('error',failed);
    child.once('exit',failed);
  });
  child.on('exit',() => { worker.dead = true; if (parked === worker) parked = undefined; });
  // An error after readiness must not become an unhandled EventEmitter error.
  child.on('error',() => retire(worker));
  return worker;
}
function take(): Worker {
  const worker = parked && !parked.dead ? parked : spawnWorker();
  parked = undefined;
  clearTimeout(worker.idle);
  worker.child.ref();
  worker.child.channel?.ref();
  return worker;
}
function park(worker: Worker) {
  if (worker.dead || parked) { retire(worker); return; }
  parked = worker;
  worker.idle = setTimeout(() => retire(worker),30000);
  worker.idle.unref();
  worker.child.unref();
  worker.child.channel?.unref();
}
async function ready(worker: Worker,signal?: AbortSignal) {
  const abort = () => retire(worker);
  signal?.addEventListener('abort',abort,{ once: true });
  try {
    if (signal?.aborted) abort();
    await worker.ready;
    if (signal?.aborted) throw new Error('VOB read cancelled');
    if (worker.dead) throw new Error('Native depth worker stopped');
  } catch (error) {
    if (signal?.aborted) throw new Error('VOB read cancelled');
    throw error;
  } finally { signal?.removeEventListener('abort',abort); }
}
export async function prepareFrozenBookWorker(signal?: AbortSignal) {
  signal?.throwIfAborted();
  const worker = take();
  try { await ready(worker,signal); park(worker); }
  catch (error) { retire(worker); throw error; }
}
export async function runFrozenVirtualBookProcess(bank: FrozenLeverageBank,selection: VirtualBookSelection,deployment: DuskDeploymentEnvelope,signal?: AbortSignal): Promise<FrozenBook> {
  signal?.throwIfAborted();
  const worker = take();
  try { await ready(worker,signal); }
  catch (error) { retire(worker); throw error; }
  return new Promise((resolveBook,reject) => {
    const requestId = randomUUID(),child = worker.child;
    let settled = false;
    const finish = (error?: Error,value?: FrozenBook) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort',abort);
      child.removeListener('message',message);
      child.removeListener('error',failed);
      child.removeListener('exit',failed);
      if (error) { retire(worker); reject(error); }
      else { park(worker); resolveBook(value!); }
    };
    const message = (value: FrozenBook & { kind: string; requestId: string }) => {
      if (value?.kind !== 'book' || value.requestId !== requestId || value.slot !== bank.slot
        || value.firstQuoteSlot !== bank.slot || value.book?.market !== selection.market)
        finish(new Error('Native depth capture unavailable'));
      else finish(undefined,value);
    };
    const failed = () => finish(new Error('Native depth worker stopped'));
    const timer = setTimeout(() => finish(new Error('Native depth capture timed out')),10000);
    const abort = () => finish(new Error('VOB read cancelled'));
    signal?.addEventListener('abort',abort,{ once: true });
    child.once('message',message);
    child.once('error',failed);
    child.once('exit',failed);
    child.send({ requestId,bank,selection,deployment },error => {
      if (error) finish(new Error('Native depth capture unavailable'));
    });
    if (signal?.aborted) abort();
  });
}
