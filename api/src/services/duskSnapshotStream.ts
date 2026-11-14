import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { currentVirtualBook, virtualBookSelection } from './duskVirtualBook';

export interface SnapshotValue {
  data: { revision: string; expiresAt: number };
  deployment: { deploymentIdentitySha256: string };
}
export interface Subscriber<T> {
  snapshot(value: T): void;
  unavailable(): void;
}
/** Failed reads in a row after which subscribers hear `unavailable` even
 * though the latest frame has not expired yet. Each tick starts a second
 * after the previous read ends. Any read that returns an unexpired snapshot,
 * new or cached, ends the run. */
export const SNAPSHOT_FAILURE_LIMIT = 5;
/** Fixed log codes for known capture failures. Never log RPC URLs,
 * credentials, request bodies or raw errors. */
export function snapshotFailureReason(error: unknown): string {
  if (!(error instanceof Error)) return 'capture-failed';
  switch (error.message) {
    case 'Depth curve does not match the current reserves':
      return 'curve-reserve-mismatch';
    // The SDK refuses to combine native depth batches that simulated against
    // different banks; parallel batches straddling a slot boundary do that.
    case 'Market depth changed during native previews':
    case 'Market depth price changed during native previews':
      return 'depth-changed-during-capture';
    case 'VOB read timed out':
      return 'rpc-timeout';
    case 'VOB read cancelled':
      return 'capture-deadline';
    case 'The Dusk stream is stale':
    case 'The Dusk stream has not attested this release':
      return 'stream-unavailable';
  }
  return /^429\b/.test(error.message) ? 'rpc-rate-limited' : 'capture-failed';
}
/** One producer per selection per API process. PostgreSQL coalesces replicas.
 * Disconnected topics stop work; slow clients disconnect instead of queuing.
 *
 * A failed read keeps the latest frame and the next tick retries. Subscribers
 * hear `unavailable` when that frame expires, or after
 * `SNAPSHOT_FAILURE_LIMIT` failed reads in a row, whichever comes first; until
 * a fresh frame arrives, every later tick without one repeats it, so a
 * subscriber joining during the outage hears it too. No frame is delivered at
 * or past its `expiresAt`. A revision names one immutable capture, so a
 * repeated revision is never delivered twice and keeps its first expiry.
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
      expiry?: ReturnType<typeof setTimeout>;
      latest?: T;
      failures: number;
      outage: boolean;
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
        topic = {
          listeners: new Set(),
          failures: 0,
          outage: false,
          stopped: false,
        };
        topics.set(key, topic);
        const state = topic;
        const unavailable = (cause: 'expired' | 'failures' | 'ongoing') => {
          if (!state.outage)
            console.warn('Dusk shared snapshot unavailable', {
              topic: key,
              cause,
              consecutiveFailures: state.failures,
            });
          state.outage = true;
          state.latest = undefined;
          clearTimeout(state.expiry);
          for (const listener of [...state.listeners]) listener.unavailable();
        };
        const publish = (snapshot: T) => {
          state.latest = snapshot;
          clearTimeout(state.expiry);
          state.expiry = setTimeout(() => {
            if (!state.stopped && state.latest === snapshot)
              unavailable('expired');
          }, snapshot.data.expiresAt - Date.now());
          for (const listener of [...state.listeners])
            listener.snapshot(snapshot);
        };
        const tick = async () => {
          let fresh = false;
          try {
            const snapshot = await read(selection);
            if (state.stopped) return;
            if (snapshot && snapshot.data.expiresAt > Date.now()) {
              fresh = true;
              state.failures = 0;
              state.outage = false;
              if (snapshot.data.revision !== state.latest?.data.revision)
                publish(snapshot);
            }
          } catch (error) {
            if (state.stopped) return;
            state.failures++;
            console.warn('Dusk shared snapshot capture failed', {
              topic: key,
              reason: snapshotFailureReason(error),
              consecutiveFailures: state.failures,
            });
          }
          // Schedule first: the last subscriber leaving on `unavailable` must
          // find, and clear, the next tick.
          state.timer = setTimeout(() => {
            void tick();
          }, 1000);
          if (fresh) return;
          if (state.outage) unavailable('ongoing');
          else if (state.failures >= SNAPSHOT_FAILURE_LIMIT)
            unavailable('failures');
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
          clearTimeout(selected.expiry);
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
    (selection) =>
      `${selection.market}:${selection.groupingBps}:${selection.levels}`,
  );
}
export const virtualBookHub = createVirtualBookHub();
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
  source: Pick<typeof virtualBookHub, 'subscribe'> = virtualBookHub,
): Promise<void> {
  return openDuskSnapshotStream(
    req,
    res,
    virtualBookSelection(
      req.params.market,
      req.query.groupingBps ?? '10',
      req.query.levels ?? '12',
    ),
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
