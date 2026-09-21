import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { currentVirtualBook, virtualBookSelection } from './duskVirtualBook';

interface SnapshotValue {
  data: { revision: string; expiresAt: number };
  deployment: { deploymentIdentitySha256: string };
}
interface Subscriber<T> {
  snapshot(value: T): void;
  unavailable(): void;
}
/** One producer per selection per API process. PostgreSQL coalesces replicas.
 * Disconnected topics stop work; slow clients disconnect instead of queuing.
 */
export function createDuskSnapshotHub<S, T extends SnapshotValue>(
  read: (selection: S) => Promise<T | null>,
  keyFor: (selection: S) => string,
) {
  const topics = new Map<
    string,
    {
      listeners: Set<Subscriber<T>>;
      timer?: ReturnType<typeof setTimeout>;
      latest?: T;
      stopped: boolean;
    }
  >();
  return {
    subscribe(selection: S, subscriber: Subscriber<T>) {
      const key = keyFor(selection);
      let topic = topics.get(key);
      if (!topic) {
        if (topics.size >= 16)
          throw Object.assign(new Error('Market snapshot capacity reached'), {
            status: 429,
          });
        topic = { listeners: new Set(), stopped: false };
        topics.set(key, topic);
        const state = topic;
        const tick = async () => {
          try {
            const snapshot = await read(selection);
            if (state.stopped) return;
            if (
              snapshot &&
              snapshot.data.revision !== state.latest?.data.revision
            ) {
              state.latest = snapshot;
              for (const listener of [...state.listeners])
                listener.snapshot(snapshot);
            }
          } catch (error) {
            // Never log RPC URLs, credentials, request bodies or raw errors.
            const reason =
              error instanceof Error &&
              error.message ===
                'Depth curve does not match the current reserves'
                ? 'curve-reserve-mismatch'
                : 'capture-failed';
            console.warn('Dusk shared snapshot unavailable', {
              topic: key,
              reason,
            });
            for (const listener of [...state.listeners]) listener.unavailable();
          } finally {
            if (!state.stopped)
              state.timer = setTimeout(() => {
                void tick();
              }, 1000);
          }
        };
        // Subscribe before a synchronously resolved cached snapshot can publish.
        queueMicrotask(() => {
          void tick();
        });
      }
      topic.listeners.add(subscriber);
      if (topic.latest && topic.latest.data.expiresAt > Date.now())
        subscriber.snapshot(topic.latest);
      const selected = topic;
      return () => {
        if (selected.stopped) return;
        selected.listeners.delete(subscriber);
        if (!selected.listeners.size) {
          selected.stopped = true;
          clearTimeout(selected.timer);
          topics.delete(key);
        }
      };
    },
    get size() {
      return topics.size;
    },
  };
}
export function createVirtualBookHub(read = currentVirtualBook) {
  return createDuskSnapshotHub(
    read,
    (selection) => `${selection.market}:${selection.groupingBps}`,
  );
}
const hub = createVirtualBookHub();
const active = new Set<() => void>();
/** Room for a backlog of roughly two maximum-size frames, never a queue that
 * grows with how far behind a reader falls. */
const MAX_PENDING_BYTES = 4 * 1024 * 1024;
export function stopDuskSnapshotStreams() {
  for (const close of [...active]) close();
}
export async function openVirtualBookStream(
  req: Request,
  res: Response,
  source: Pick<typeof hub, 'subscribe'> = hub,
): Promise<void> {
  return openDuskSnapshotStream(
    req,
    res,
    virtualBookSelection(req.params.market, req.query.groupingBps ?? '10'),
    'dusk-virtual-book',
    source,
  );
}
export async function openDuskSnapshotStream<S, T extends SnapshotValue>(
  req: Request,
  res: Response,
  selection: S,
  eventName: string,
  source: { subscribe(selection: S, subscriber: Subscriber<T>): () => void },
): Promise<void> {
  if (active.size >= 128)
    throw Object.assign(new Error('Snapshot stream capacity reached'), {
      status: 429,
    });
  let stopped = false,
    sequence = 0,
    identity: string | undefined;
  let unsubscribe: (() => void) | undefined;
  const streamId = randomUUID();
  const close = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(heartbeat);
    clearTimeout(initialTimeout);
    unsubscribe?.();
    active.delete(close);
    req.removeListener('aborted', close);
    res.removeListener('close', close);
    if (!res.writableEnded) res.end();
  };
  // `write` returning false only reports that the socket buffer crossed its
  // high water mark, 16 KiB by default. A single frame larger than that trips
  // it on a perfectly healthy reader, so it cannot stand in for "slow client".
  // Only a reader that stays behind accumulates an unbounded queue, and
  // writableLength is what measures that.
  const send = (text: string) => {
    if (stopped) return;
    res.write(text);
    if (res.writableLength > MAX_PENDING_BYTES) close();
  };
  // Comments prove transport liveness only, never refresh a financial snapshot.
  const heartbeat = setInterval(() => {
    send(': heartbeat\n\n');
  }, 10_000);
  const initialTimeout = setTimeout(() => {
    if (!sequence) close();
  }, 25_000);
  active.add(close);
  req.on('aborted', close);
  res.on('close', close);
  res.status(200).set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  try {
    unsubscribe = source.subscribe(selection, {
      snapshot(value) {
        if (stopped) return;
        const next = value.deployment.deploymentIdentitySha256;
        if (identity && identity !== next) {
          close();
          return;
        }
        identity = next;
        const frame = {
          ...value,
          data: { ...value.data, streamId, sequence: ++sequence },
        };
        send(`event: ${eventName}\ndata: ${JSON.stringify(frame)}\n\n`);
      },
      unavailable: close,
    });
    // A synchronous subscriber callback may already have closed the response.
    if (stopped) unsubscribe();
  } catch {
    close();
  }
}
