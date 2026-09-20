import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import {
  currentVirtualBook,
  VirtualBookEnvelope,
  VirtualBookSelection,
  virtualBookSelection,
} from './duskVirtualBook';

interface Subscriber {
  snapshot(value: VirtualBookEnvelope): void;
  unavailable(): void;
}
/** One producer per selection per API process. PostgreSQL coalesces replicas.
 * Disconnected topics stop work; slow clients disconnect instead of queuing.
 */
export function createVirtualBookHub(read = currentVirtualBook) {
  const topics = new Map<
    string,
    {
      listeners: Set<Subscriber>;
      timer?: ReturnType<typeof setTimeout>;
      latest?: VirtualBookEnvelope;
      stopped: boolean;
    }
  >();
  return {
    subscribe(selection: VirtualBookSelection, subscriber: Subscriber) {
      const key = `${selection.market}:${selection.groupingBps}`;
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
          } catch {
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
const hub = createVirtualBookHub();
const active = new Set<() => void>();
export function stopDuskSnapshotStreams() {
  for (const close of [...active]) close();
}
export async function openVirtualBookStream(
  req: Request,
  res: Response,
  source: Pick<typeof hub, 'subscribe'> = hub,
): Promise<void> {
  const selection = virtualBookSelection(
    req.params.market,
    req.query.groupingBps ?? '10',
  );
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
  // Comments prove transport liveness only, never refresh a financial snapshot.
  const heartbeat = setInterval(() => {
    if (!res.write(': heartbeat\n\n')) close();
  }, 10_000);
  const initialTimeout = setTimeout(() => {
    if (!sequence) close();
  }, 25_000);
  active.add(close);
  req.on('aborted', close);
  res.on('close', close);
  res
    .status(200)
    .set({
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
        if (
          !res.write(
            `event: dusk-virtual-book\ndata: ${JSON.stringify(frame)}\n\n`,
          )
        )
          close();
      },
      unavailable: close,
    });
    // A synchronous subscriber callback may already have closed the response.
    if (stopped) unsubscribe();
  } catch {
    close();
  }
}
