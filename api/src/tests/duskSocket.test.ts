import test, { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { io, Socket } from 'socket.io-client';
import { createDuskSocketServer } from '../services/duskSocket';
import {
  createDuskSnapshotHub,
  SnapshotValue,
} from '../services/duskSnapshotStream';
import { PayloadSelection } from '../services/duskPayloads';
import { VirtualBookSelection } from '../services/duskVirtualBook';
import { openDuskChangeFeed } from '../services/duskChangeStream';
import type { DuskDeploymentEnvelope } from '../services/duskDeploymentService';

const market = '11111111111111111111111111111111';
interface Packet {
  id: string;
  event: string;
  data: string;
}
async function harness(t: TestContext, acknowledge = true) {
  let revision = 'r1',
    identity = 'a'.repeat(64),
    reads = 0;
  const snapshot = async (): Promise<SnapshotValue> => {
    reads++;
    return {
      data: { revision, expiresAt: Date.now() + 15_000 },
      deployment: { deploymentIdentitySha256: identity },
    };
  };
  const payload = createDuskSnapshotHub<PayloadSelection, SnapshotValue>(
    snapshot,
    JSON.stringify,
  );
  const book = createDuskSnapshotHub<VirtualBookSelection, SnapshotValue>(
    snapshot,
    JSON.stringify,
  );
  const http = createServer();
  const server = createDuskSocketServer(
    http,
    {
      payload,
      book,
      changes: (sink) =>
        openDuskChangeFeed(sink, {
          start: async () => {},
          ready: () => true,
          envelope: async () =>
            ({
              deploymentIdentitySha256: identity,
              sourceSlot: 100,
            }) as DuskDeploymentEnvelope,
          subscribe: () => () => {},
        }),
    },
    'https://webapp.example',
  );
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  const address = http.address();
  assert.ok(address && typeof address === 'object');
  const url = `http://127.0.0.1:${address.port}`;
  const clients: Socket[] = [];
  t.after(async () => {
    clients.forEach((client) => client.disconnect());
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const client = async () => {
    const socket = io(url, {
      transports: ['websocket'],
      reconnection: false,
      extraHeaders: { Origin: 'https://webapp.example' },
    });
    clients.push(socket);
    socket.on('dusk:frame', (_packet: Packet, ack: () => void) => {
      if (acknowledge) ack();
    });
    await next(socket, 'connect');
    return socket;
  };
  const socket = await client();
  return {
    socket,
    client,
    server,
    url,
    payload,
    book,
    reads: () => reads,
    update: () => {
      revision = 'r2';
    },
    upgrade: () => {
      identity = 'b'.repeat(64);
    },
  };
}
function next(socket: Socket, event = 'dusk:frame'): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, receive);
      reject(new Error(`Timed out: ${event}`));
    }, 7000);
    const receive = (value: unknown) => {
      clearTimeout(timer);
      resolve(value);
    };
    socket.once(event, receive);
  });
}
function subscribe(
  socket: Socket,
  id: string,
  channel: string,
  selection?: unknown,
): Promise<{ ok: boolean; code?: string }> {
  return socket.timeout(2000).emitWithAck('dusk:subscribe', {
    id,
    channel,
    ...(selection ? { selection } : {}),
  });
}

test('all Dusk feeds multiplex over one connection, with original envelopes and fresh stream identities', async (t) => {
  const h = await harness(t);
  const selections = [
    { kind: 'markets' },
    { kind: 'wallet', owner: market },
    { kind: 'statistics', range: '24h' },
    { kind: 'trades', market },
    { kind: 'candles', market, side: 'base', resolutionSeconds: 60 },
  ];
  for (const [i, selection] of selections.entries()) {
    const received = next(h.socket);
    assert.equal(
      (await subscribe(h.socket, `p${i}`, 'payload', selection)).ok,
      true,
    );
    const frame = await received;
    assert.equal(frame.id, `p${i}`);
    assert.equal(frame.event, 'dusk-payload');
    assert.equal(JSON.parse(frame.data).data.sequence, 1);
    assert.equal(
      JSON.parse(frame.data).deployment.deploymentIdentitySha256,
      'a'.repeat(64),
    );
  }
  let received = next(h.socket);
  await subscribe(h.socket, 'book', 'virtual-book', {
    market,
    groupingBps: 10,
  });
  assert.equal((await received).event, 'dusk-virtual-book');
  received = next(h.socket);
  await subscribe(h.socket, 'changes', 'changes');
  const change = JSON.parse((await received).data);
  assert.equal(change.data.kind, 'resync');
  assert.equal(change.data.sequence, 1);
  assert.equal(h.server.of('/').sockets.size, 1);
});

test('subscribers share capture, unsubscribe releases topics, reconnect gets sequence 1 under a new streamId', async (t) => {
  const h = await harness(t);
  let received = next(h.socket);
  await subscribe(h.socket, 'a', 'payload', { kind: 'markets' });
  const first = JSON.parse((await received).data);
  const other = await h.client();
  received = next(other);
  await subscribe(other, 'b', 'payload', { kind: 'markets' });
  const second = JSON.parse((await received).data);
  assert.equal(h.reads(), 1);
  assert.equal(h.payload.size, 1);
  assert.notEqual(first.data.streamId, second.data.streamId);
  h.socket.disconnect();
  other.emit('dusk:unsubscribe', 'b');
  // The following acknowledged command forms an ordered processing barrier.
  await subscribe(other, 'invalid', 'unknown');
  assert.equal(h.payload.size, 0);
  received = next(other);
  await subscribe(other, 'c', 'payload', { kind: 'markets' });
  const reconnected = JSON.parse((await received).data);
  assert.equal(reconnected.data.sequence, 1);
  assert.notEqual(second.data.streamId, reconnected.data.streamId);
});

test('invalid selections, duplicate ids, and subscription capacity are rejected without replacing feeds', async (t) => {
  const h = await harness(t);
  for (const [channel, selection] of [
    ['payload', { kind: 'markets', unexpected: true }],
    [
      'payload',
      { kind: 'candles', market, side: 'base', resolutionSeconds: 1 },
    ],
    ['virtual-book', { market, groupingBps: 3 }],
    ['changes', { arbitrary: true }],
  ] as const)
    assert.equal(
      (await subscribe(h.socket, 'invalid', channel, selection)).ok,
      false,
    );
  assert.equal(h.payload.size, 0);
  for (let i = 0; i < 16; i++)
    assert.equal(
      (await subscribe(h.socket, `p${i}`, 'payload', { kind: 'markets' })).ok,
      true,
    );
  assert.equal(
    (await subscribe(h.socket, 'overflow', 'payload', { kind: 'markets' }))
      .code,
    'subscription-capacity',
  );
  assert.equal(
    (await subscribe(h.socket, 'p0', 'payload', { kind: 'markets' })).ok,
    false,
  );
  assert.equal(h.payload.size, 1);
});

test('slow readers release their subscription instead of growing an unbounded send queue', async (t) => {
  const h = await harness(t, false);
  const first = next(h.socket);
  await subscribe(h.socket, 'slow', 'payload', { kind: 'markets' });
  await first;
  const failed = next(h.socket, 'dusk:error');
  h.update();
  assert.equal((await failed).id, 'slow');
  assert.equal(h.payload.size, 0);
});

test('deployment changes end the subscription before a mixed-identity frame can be sent', async (t) => {
  const h = await harness(t);
  const first = next(h.socket);
  await subscribe(h.socket, 'p', 'payload', { kind: 'markets' });
  await first;
  const failed = next(h.socket, 'dusk:error');
  h.upgrade();
  h.update();
  assert.equal((await failed).id, 'p');
  assert.equal(h.payload.size, 0);
});

test('websocket handshake enforces the configured browser origin', async (t) => {
  const h = await harness(t);
  const client = io(h.url, {
    transports: ['websocket'],
    reconnection: false,
    extraHeaders: { Origin: 'https://untrusted.example' },
  });
  t.after(() => client.disconnect());
  await next(client, 'connect_error');
  assert.equal(h.server.of('/').sockets.size, 1);
});

test('brief acknowledgement latency queues frames in sequence instead of dropping the subscription', async (t) => {
  const h = await harness(t, false);
  const acknowledgements: Array<() => void> = [];
  const errors: unknown[] = [];
  h.socket.on('dusk:frame', (_packet: Packet, ack: () => void) =>
    acknowledgements.push(ack),
  );
  h.socket.on('dusk:error', (error) => errors.push(error));
  const first = next(h.socket);
  await subscribe(h.socket, 'delayed', 'payload', { kind: 'markets' });
  const firstFrame = JSON.parse((await first).data);
  h.update();
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.deepEqual(errors, []);
  assert.equal(acknowledgements.length, 1);
  const second = next(h.socket);
  acknowledgements.shift()!();
  const secondFrame = JSON.parse((await second).data);
  acknowledgements.shift()!();
  assert.equal(secondFrame.data.sequence, 2);
  assert.equal(secondFrame.data.streamId, firstFrame.data.streamId);
  assert.equal(h.payload.size, 1);
});
