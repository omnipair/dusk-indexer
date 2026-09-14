import { randomUUID } from 'crypto';
import type { Request, Response } from 'express';
import { deploymentEnvelope, DuskDeploymentEnvelope } from './duskDeploymentService';
import { subscribeDuskReadChanges, DuskReadChange } from './duskChangeBus';
import { duskInvalidationListenerReady, startDuskInvalidationListener } from './duskInvalidationService';

export const DUSK_CHANGE_STREAM_HEARTBEAT_MS = 15_000;
export const DUSK_CHANGE_STREAM_BATCH_MS = 5_000;
export const DUSK_CHANGE_STREAM_OBSERVATION_TIMEOUT_MS = 20_000;
const active = new Set<() => void>();

interface Dependencies {
  start(): Promise<void>;
  ready(): boolean;
  envelope(slot: number): Promise<DuskDeploymentEnvelope>;
  subscribe(listener: (change: DuskReadChange) => void): () => void;
}
const dependencies: Dependencies = {
  start: startDuskInvalidationListener,
  ready: duskInvalidationListenerReady,
  envelope: slot => deploymentEnvelope(slot, { fresh: true }),
  subscribe: subscribeDuskReadChanges,
};

/** One bounded HTTP stream carries hints only. Every frame has a fresh envelope. */
export async function openDuskChangeStream(req: Request, res: Response, deps: Dependencies = dependencies): Promise<void> {
  if (active.size >= 128) throw Object.assign(new Error('Native change stream capacity reached'), { status: 429 });
  let closed = false, initialized = false, sending = false, sequence = 0, lastSentAt = 0;
  let identity = '', pendingKind: 'change' | 'resync' | 'heartbeat' | undefined, pendingSlot = 0;
  let timer: ReturnType<typeof setTimeout> | undefined, heartbeat: ReturnType<typeof setInterval> | undefined;
  let unsubscribe: (() => void) | undefined;
  const waiting = new Set<() => void>();
  const streamId = randomUUID();
  function close() {
    if (closed) return;
    closed = true;
    if (timer) clearTimeout(timer);
    if (heartbeat) clearInterval(heartbeat);
    for (const cancel of waiting) cancel();
    unsubscribe?.();
    active.delete(close);
    req.removeListener('aborted', close);
    res.removeListener('close', close);
    if (initialized && !res.writableEnded) res.end();
  }
  async function bounded<T>(operation: Promise<T>): Promise<T> {
    let cancel!: () => void;
    const expired = new Promise<never>((_, reject) => {
      cancel = () => reject(new Error('Native change observation unavailable'));
    });
    const deadline = setTimeout(cancel, DUSK_CHANGE_STREAM_OBSERVATION_TIMEOUT_MS);
    deadline.unref();
    waiting.add(cancel);
    try { return await Promise.race([operation, expired]); }
    finally { clearTimeout(deadline); waiting.delete(cancel); }
  }
  function write(kind: 'change' | 'resync' | 'heartbeat', sourceSlot: number, deployment: DuskDeploymentEnvelope) {
    if (closed) return;
    if (!deps.ready() || deployment.deploymentIdentitySha256 !== identity || deployment.sourceSlot < sourceSlot) {
      close(); return;
    }
    const frame = { success: true, data: { schemaVersion: 'dusk-read-change.v1', streamId,
      sequence: ++sequence, kind, sourceSlot }, deployment };
    lastSentAt = Date.now();
    // Slow clients reconnect and resync. Never accumulate an unbounded send queue.
    if (!res.write(`event: dusk-change\ndata: ${JSON.stringify(frame)}\n\n`)) close();
  }
  function schedule(kind: 'change' | 'resync' | 'heartbeat', slot = 0) {
    if (closed) return;
    if (kind === 'resync' || !pendingKind || pendingKind === 'heartbeat') pendingKind = kind;
    pendingSlot = Math.max(pendingSlot, slot);
    if (!initialized || sending || timer) return;
    timer = setTimeout(() => { timer = undefined; void send(); }, Math.max(0, lastSentAt + DUSK_CHANGE_STREAM_BATCH_MS - Date.now()));
    timer.unref();
  }
  async function send() {
    if (closed || sending || !pendingKind) return;
    sending = true;
    const kind = pendingKind, slot = pendingSlot;
    pendingKind = undefined; pendingSlot = 0;
    try { write(kind, slot, await bounded(deps.envelope(slot))); }
    catch { close(); }
    finally {
      sending = false;
      if (pendingKind) schedule(pendingKind, pendingSlot);
    }
  }
  active.add(close);
  req.on('aborted', close);
  res.on('close', close);
  try {
    unsubscribe = deps.subscribe(change => {
      if (change.kind === 'unavailable') { if (initialized) close(); }
      else schedule(change.kind, change.sourceSlot);
    });
    await bounded(deps.start());
    if (closed) return;
    const deployment = await bounded(deps.envelope(0));
    if (closed) return;
    if (!deps.ready()) throw new Error('Database change listener unavailable');
    identity = deployment.deploymentIdentitySha256;
    res.status(200).set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
    initialized = true;
    res.flushHeaders();
    write('resync', 0, deployment);
    if (closed) return;
    if (pendingKind) schedule(pendingKind, pendingSlot);
    heartbeat = setInterval(() => schedule('heartbeat'), DUSK_CHANGE_STREAM_HEARTBEAT_MS);
    heartbeat.unref();
  } catch {
    const disconnected = closed;
    close();
    if (!initialized && !disconnected) throw Object.assign(new Error('Native change stream unavailable'), { status: 503 });
  }
}
