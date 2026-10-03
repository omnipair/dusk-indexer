import type { Server as HttpServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Server } from 'socket.io';
import { payloadSelection, PayloadSelection } from './duskPayloads';
import { virtualBookSelection, VirtualBookSelection } from './duskVirtualBook';
import { payloadHub } from './duskPayloadStream';
import {
  virtualBookHub,
  SnapshotValue,
  Subscriber,
} from './duskSnapshotStream';
import { openDuskChangeFeed, DuskChangeSink } from './duskChangeStream';

export interface DuskSocketSources {
  payload: {
    subscribe(
      selection: PayloadSelection,
      subscriber: Subscriber<SnapshotValue>,
    ): () => void;
  };
  book: {
    subscribe(
      selection: VirtualBookSelection,
      subscriber: Subscriber<SnapshotValue>,
    ): () => void;
  };
  changes(sink: DuskChangeSink): { ready: Promise<void>; close(): void };
}
const sources: DuskSocketSources = {
  payload: payloadHub,
  book: virtualBookHub,
  changes: openDuskChangeFeed,
};
const MAX_FRAME_BYTES = 2 * 1024 * 1024;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const validId = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-zA-Z0-9-]{1,64}$/.test(value);

/** One connection carries independently cancellable, bounded subscriptions.
 * No replay: each reconnect starts a new resync/full snapshot, with sequence 1.
 * Only this read API uses Socket.IO; chain ingestion and RPC stay unchanged.
 */
export function createDuskSocketServer(
  http: HttpServer,
  feeds = sources,
  origin = process.env.CORS_ORIGIN || '*',
) {
  const io = new Server(http, {
    path: '/socket.io',
    serveClient: false,
    transports: ['websocket'],
    maxHttpBufferSize: 16 * 1024,
    cors: { origin },
    allowRequest: (req, done) =>
      done(
        null,
        origin === '*' || !req.headers.origin || req.headers.origin === origin,
      ),
  });
  let subscriptions = 0;
  io.use((_socket, next) => {
    next(
      io.of('/').sockets.size >= 128
        ? new Error('Stream capacity reached')
        : undefined,
    );
  });
  io.on('connection', (socket) => {
    const active = new Map<string, () => void>();
    let commands = 0,
      windowStart = Date.now();
    const allowed = () => {
      if (Date.now() - windowStart >= 10_000) {
        commands = 0;
        windowStart = Date.now();
      }
      if (++commands <= 60) return true;
      socket.disconnect(true);
      return false;
    };
    socket.on(
      'dusk:subscribe',
      (
        request: unknown,
        ack?: (result: { ok: boolean; code?: string }) => void,
      ) => {
        if (!allowed()) return;
        const respond = (ok: boolean, code?: string) => {
          if (typeof ack === 'function') ack({ ok, ...(code ? { code } : {}) });
        };
        if (
          !isRecord(request) ||
          !validId(request.id) ||
          Object.keys(request).some(
            (key) => !['id', 'channel', 'selection'].includes(key),
          )
        ) {
          respond(false, 'invalid-subscription');
          return;
        }
        const { id, channel } = request;
        if (active.has(id) || active.size >= 16 || subscriptions >= 512) {
          respond(false, 'subscription-capacity');
          return;
        }
        let selection: PayloadSelection | VirtualBookSelection | undefined;
        try {
          if (channel === 'changes') {
            if (request.selection !== undefined) throw new Error();
          } else if (channel === 'payload' && isRecord(request.selection)) {
            const input = { ...request.selection };
            if (typeof input.resolutionSeconds === 'number')
              input.resolutionSeconds = String(input.resolutionSeconds);
            selection = payloadSelection(input);
          } else if (
            channel === 'virtual-book' &&
            isRecord(request.selection) &&
            Object.keys(request.selection).every((key) =>
              ['market', 'groupingBps'].includes(key),
            )
          ) {
            const { market, groupingBps } = request.selection;
            selection = virtualBookSelection(
              market,
              typeof groupingBps === 'number'
                ? String(groupingBps)
                : groupingBps,
            );
          } else throw new Error();
        } catch {
          respond(false, 'invalid-selection');
          return;
        }

        let stopped = false,
          pending = false,
          sequence = 0,
          identity: string | undefined;
        const queued: Array<{ event: string; data: string; bytes: number }> =
          [];
        let queuedBytes = 0;
        let unsubscribe: (() => void) | undefined;
        const streamId = randomUUID();
        const close = () => {
          if (stopped) return;
          stopped = true;
          clearTimeout(initialTimeout);
          queued.length = 0;
          queuedBytes = 0;
          active.delete(id);
          subscriptions--;
          unsubscribe?.();
        };
        const fail = () => {
          if (stopped) return;
          close();
          socket.emit('dusk:error', { id, code: 'stream-unavailable' });
        };
        // One frame in flight; tolerate brief latency/bursts with a bounded FIFO.
        // Preserve sequence order, and force a full resync if a reader falls behind.
        const deliver = (packet: { event: string; data: string }) => {
          pending = true;
          socket
            .timeout(5_000)
            .emit('dusk:frame', { id, ...packet }, (error: Error | null) => {
              if (stopped) return;
              pending = false;
              if (error) {
                fail();
                return;
              }
              const next = queued.shift();
              if (next) {
                queuedBytes -= next.bytes;
                deliver({ event: next.event, data: next.data });
              }
            });
        };
        const send = (event: string, frame: unknown): boolean => {
          if (stopped) return false;
          const data = JSON.stringify(frame);
          const bytes = Buffer.byteLength(data);
          if (
            bytes > MAX_FRAME_BYTES ||
            queuedBytes + bytes > 4 * 1024 * 1024 ||
            queued.length >= 32
          ) {
            fail();
            return false;
          }
          clearTimeout(initialTimeout);
          if (pending) {
            queued.push({ event, data, bytes });
            queuedBytes += bytes;
          } else deliver({ event, data });
          return !stopped;
        };
        const initialTimeout = setTimeout(fail, 25_000);
        initialTimeout.unref();
        active.set(id, close);
        subscriptions++;
        respond(true);
        try {
          if (channel === 'changes') {
            const feed = feeds.changes({
              start() {},
              write: (frame) => send('dusk-change', frame),
              close: fail,
            });
            unsubscribe = feed.close;
            void feed.ready.catch(fail);
          } else {
            const subscriber: Subscriber<SnapshotValue> = {
              snapshot(value) {
                if (stopped) return;
                if (
                  identity &&
                  identity !== value.deployment.deploymentIdentitySha256
                ) {
                  fail();
                  return;
                }
                identity = value.deployment.deploymentIdentitySha256;
                send(
                  channel === 'payload' ? 'dusk-payload' : 'dusk-virtual-book',
                  {
                    ...value,
                    data: { ...value.data, streamId, sequence: ++sequence },
                  },
                );
              },
              unavailable: fail,
            };
            unsubscribe =
              channel === 'payload'
                ? feeds.payload.subscribe(
                    selection as PayloadSelection,
                    subscriber,
                  )
                : feeds.book.subscribe(
                    selection as VirtualBookSelection,
                    subscriber,
                  );
          }
          // Cached snapshots and producer errors may arrive synchronously.
          if (stopped) unsubscribe();
        } catch {
          fail();
        }
      },
    );
    socket.on('dusk:unsubscribe', (id: unknown) => {
      if (allowed() && validId(id)) active.get(id)?.();
    });
    socket.on('disconnect', () => {
      for (const stop of [...active.values()]) stop();
    });
  });
  return io;
}
