import test, { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';
import {
  createVirtualBookHub,
  openVirtualBookStream,
  SNAPSHOT_FAILURE_LIMIT,
  snapshotFailureReason,
} from '../services/duskSnapshotStream';
import {
  VIRTUAL_BOOK_MAX_AGE_MS,
  VirtualBookEnvelope,
} from '../services/duskVirtualBook';
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const selection = {
  market: '11111111111111111111111111111111',
  groupingBps: 10,
  levels: 12,
};
function snapshot(revision = 'r1', lifetime = VIRTUAL_BOOK_MAX_AGE_MS) {
  return {
    success: true,
    deployment: { deploymentIdentitySha256: 'a'.repeat(64) },
    data: { revision, expiresAt: Date.now() + lifetime },
  } as VirtualBookEnvelope;
}
const bankSkew = () =>
  new Error('Market depth changed during native previews');
/** Records what one subscriber received. A closing subscriber unsubscribes
 * on `unavailable`, as the socket and SSE streams do; a passive one stays. */
function client(
  hub: ReturnType<typeof createVirtualBookHub>,
  closing = true,
) {
  const seen = { frames: [] as string[], outages: 0, stop: () => {} };
  seen.stop = hub.subscribe(selection, {
    snapshot: (value) => {
      seen.frames.push(value.data.revision);
    },
    unavailable: () => {
      seen.outages++;
      if (closing) seen.stop();
    },
  });
  return seen;
}
/** Silences hub warnings; `calls` is a fresh copy on every read. */
function quietWarnings(t: TestContext) {
  return t.mock.method(console, 'warn', () => {}).mock;
}
test('100 clients share one capture; same revision is not rebroadcast; last disconnect stops work', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100_000 });
  let calls = 0,
    frames = 0,
    revision = 'r1';
  const hub = createVirtualBookHub(async () => {
    calls++;
    return snapshot(revision);
  });
  const stops = Array.from({ length: 100 }, () =>
    hub.subscribe(selection, {
      snapshot: () => {
        frames++;
      },
      unavailable: () => {
        throw new Error('Unexpected outage');
      },
    }),
  );
  await flush();
  assert.equal(calls, 1);
  assert.equal(frames, 100);
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(calls, 2);
  assert.equal(frames, 100);
  revision = 'r2';
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(frames, 200);
  stops.forEach((stop) => stop());
  assert.equal(hub.size, 0);
  t.mock.timers.tick(10_000);
  await flush();
  assert.equal(calls, 3);
});
test('slow captures never overlap and disconnected results cannot reach clients', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let finish!: (value: VirtualBookEnvelope) => void,
    calls = 0,
    frames = 0;
  const hub = createVirtualBookHub(() => {
    calls++;
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const stop = hub.subscribe(selection, {
    snapshot: () => {
      frames++;
    },
    unavailable: () => {},
  });
  await flush();
  t.mock.timers.tick(20_000);
  await flush();
  assert.equal(calls, 1);
  stop();
  finish(snapshot());
  await flush();
  assert.equal(frames, 0);
  assert.equal(hub.size, 0);
});
test('a passing capture failure keeps every subscriber on the latest frame', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100_000 });
  const warnings = quietWarnings(t);
  const reads: Array<() => VirtualBookEnvelope> = [
    () => snapshot('r1'),
    () => {
      throw bankSkew();
    },
    () => snapshot('r2'),
  ];
  const hub = createVirtualBookHub(async () => reads.shift()!());
  const first = client(hub),
    second = client(hub);
  await flush();
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(hub.size, 1);
  assert.deepEqual([first.outages, second.outages], [0, 0]);
  // Joining right after the failure still gets the frame everyone holds.
  const late = client(hub);
  assert.deepEqual(late.frames, ['r1']);
  t.mock.timers.tick(1000);
  await flush();
  for (const seen of [first, second])
    assert.deepEqual(seen.frames, ['r1', 'r2']);
  assert.deepEqual(late.frames, ['r1', 'r2']);
  assert.equal(late.outages, 0);
  assert.deepEqual(
    warnings.calls.map((call) => call.arguments),
    [
      [
        'Dusk shared snapshot capture failed',
        {
          topic: `${selection.market}:10:12`,
          reason: 'depth-changed-during-capture',
          consecutiveFailures: 1,
        },
      ],
    ],
  );
});
test('a sustained failure ends exactly when the latest frame expires', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100_000 });
  const warnings = quietWarnings(t);
  const captured = snapshot('r1');
  let reads = 0;
  // Every other read fails; between them the shared snapshot's cooldown
  // serves the cached capture until it expires, so the failure limit is
  // never reached and only expiry can end the run.
  const hub = createVirtualBookHub(async () => {
    if (++reads % 2 === 0) throw bankSkew();
    return Date.now() < captured.data.expiresAt ? captured : null;
  });
  const closing = client(hub),
    passive = client(hub, false);
  await flush();
  while (Date.now() < captured.data.expiresAt - 1000) {
    t.mock.timers.tick(1000);
    await flush();
  }
  t.mock.timers.tick(999);
  await flush();
  assert.equal(closing.outages + passive.outages, 0);
  const late = client(hub);
  assert.deepEqual(late.frames, ['r1']);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(Date.now(), captured.data.expiresAt);
  assert.deepEqual([closing.outages, late.outages], [1, 1]);
  // A subscriber that stays hears it again on every tick without a frame.
  assert.ok(passive.outages >= 1);
  // The expired frame is never handed to anyone joining afterwards, and the
  // outage repeats on the next tick without a fresh frame.
  const after = client(hub, false);
  assert.deepEqual(after.frames, []);
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(after.outages, 1);
  assert.deepEqual(closing.frames, ['r1']);
  assert.deepEqual(passive.frames, ['r1']);
  assert.deepEqual(
    warnings.calls
      .map((call) => call.arguments)
      .filter(([message]) => message === 'Dusk shared snapshot unavailable'),
    [
      [
        'Dusk shared snapshot unavailable',
        {
          topic: `${selection.market}:10:12`,
          cause: 'expired',
          consecutiveFailures: 1,
        },
      ],
    ],
  );
});
test('a sustained failure ends at the failure limit before a long-lived frame expires', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100_000 });
  const warnings = quietWarnings(t);
  let reads = 0;
  const hub = createVirtualBookHub(async () => {
    if (++reads === 1) return snapshot('r1', 60_000);
    throw new Error('VOB read timed out');
  });
  const seen = client(hub);
  await flush();
  for (let failure = 1; failure < SNAPSHOT_FAILURE_LIMIT; failure++) {
    t.mock.timers.tick(1000);
    await flush();
  }
  assert.equal(seen.outages, 0);
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(seen.outages, 1);
  assert.equal(hub.size, 0);
  assert.deepEqual(warnings.calls.at(-1)?.arguments, [
    'Dusk shared snapshot unavailable',
    {
      topic: `${selection.market}:10:12`,
      cause: 'failures',
      consecutiveFailures: SNAPSHOT_FAILURE_LIMIT,
    },
  ]);
  // A selection that never captured is refused after the same bounded run.
  const never = createVirtualBookHub(async () => {
    throw new Error('VOB read timed out');
  });
  const waiting = client(never);
  await flush();
  for (let failure = 1; failure < SNAPSHOT_FAILURE_LIMIT; failure++) {
    t.mock.timers.tick(1000);
    await flush();
  }
  assert.equal(waiting.outages, 1);
  assert.deepEqual(waiting.frames, []);
});
test('captures recover after failures, and after an outage', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100_000 });
  quietWarnings(t);
  let failing = false,
    revision = 0;
  const hub = createVirtualBookHub(async () => {
    if (failing) throw bankSkew();
    return snapshot(`r${++revision}`);
  });
  const seen = client(hub, false);
  await flush();
  const ticks = async (count: number) => {
    for (let i = 0; i < count; i++) {
      t.mock.timers.tick(1000);
      await flush();
    }
  };
  // One short of the limit, then a fresh frame resets the run.
  failing = true;
  await ticks(SNAPSHOT_FAILURE_LIMIT - 1);
  failing = false;
  await ticks(1);
  failing = true;
  await ticks(SNAPSHOT_FAILURE_LIMIT - 1);
  assert.equal(seen.outages, 0);
  assert.deepEqual(seen.frames, ['r1', 'r2']);
  await ticks(1);
  assert.equal(seen.outages, 1);
  // A fresh frame ends the outage for a subscriber that stayed.
  failing = false;
  await ticks(1);
  assert.deepEqual(seen.frames, ['r1', 'r2', 'r3']);
  failing = true;
  await ticks(SNAPSHOT_FAILURE_LIMIT - 1);
  assert.equal(seen.outages, 1);
});
test('a subscriber joining during a failure run gets the latest frame and the outage', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100_000 });
  quietWarnings(t);
  let reads = 0;
  const hub = createVirtualBookHub(async () => {
    if (++reads === 1) return snapshot('r1');
    throw bankSkew();
  });
  const early = client(hub, false);
  await flush();
  for (let failure = 1; failure <= 2; failure++) {
    t.mock.timers.tick(1000);
    await flush();
  }
  const late = client(hub, false);
  assert.deepEqual(late.frames, ['r1']);
  while (early.outages === 0) {
    t.mock.timers.tick(1000);
    await flush();
  }
  assert.equal(reads, SNAPSHOT_FAILURE_LIMIT + 1);
  assert.deepEqual([early.outages, late.outages], [1, 1]);
  // Joining once the outage is known: no frame, and the next tick says so.
  const later = client(hub, false);
  assert.deepEqual(later.frames, []);
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(later.outages, 1);
});
test('failure reasons are fixed codes and never carry the raw error', () => {
  const leaked = new Error(
    '429 Too Many Requests: {"error":"limit"} https://rpc.example/?api-key=secret',
  );
  assert.equal(snapshotFailureReason(leaked), 'rpc-rate-limited');
  assert.equal(snapshotFailureReason(bankSkew()), 'depth-changed-during-capture');
  assert.equal(
    snapshotFailureReason(
      new Error('Market depth price changed during native previews'),
    ),
    'depth-changed-during-capture',
  );
  assert.equal(
    snapshotFailureReason(
      new Error('Depth curve does not match the current reserves'),
    ),
    'curve-reserve-mismatch',
  );
  assert.equal(
    snapshotFailureReason(new Error('The Dusk stream is stale')),
    'stream-unavailable',
  );
  assert.equal(snapshotFailureReason(new Error('VOB read cancelled')), 'capture-deadline');
  assert.equal(snapshotFailureReason(new Error('anything else')), 'capture-failed');
  assert.equal(snapshotFailureReason('not an error'), 'capture-failed');
});
class Sink extends EventEmitter {
  writableEnded = false;
  frames: string[] = [];
  /** What Node still has queued. `write` reports false above the 16 KiB high
   * water mark, which one large frame reaches on an idle, healthy reader. */
  writableLength = 0;
  status() {
    return this;
  }
  set() {
    return this;
  }
  flushHeaders() {}
  write(value: string) {
    this.frames.push(value);
    return this.writableLength <= 16 * 1024;
  }
  end() {
    this.writableEnded = true;
  }
}
test('SSE sequences snapshots, keeps an oversized frame open, and drops a reader that stays behind', async () => {
  for (const behind of [false, true]) {
    const req = Object.assign(new EventEmitter(), {
        params: { market: selection.market },
        query: { groupingBps: '10' },
      }),
      res = new Sink();
    let emit!: (value: VirtualBookEnvelope) => void,
      unsubscribed = 0;
    await openVirtualBookStream(
      req as unknown as Request,
      res as unknown as Response,
      {
        subscribe: (_selection, subscriber) => {
          emit = subscriber.snapshot;
          return () => {
            unsubscribed++;
          };
        },
      },
    );
    // Both readers push `write` past the high water mark. Only the second is
    // actually behind; the first is simply receiving a frame over 16 KiB.
    res.writableLength = behind ? 8 * 1024 * 1024 : 64 * 1024;
    emit(snapshot());
    const first = JSON.parse(res.frames[0].split('\ndata: ')[1]);
    assert.equal(first.data.sequence, 1);
    if (!behind) {
      assert.equal(res.writableEnded, false);
      assert.equal(unsubscribed, 0);
      emit(snapshot('r2'));
      assert.equal(
        JSON.parse(res.frames[1].split('\ndata: ')[1]).data.sequence,
        2,
      );
      const upgraded = snapshot('r3');
      upgraded.deployment = {
        ...upgraded.deployment,
        deploymentIdentitySha256: 'b'.repeat(64),
      };
      emit(upgraded);
    }
    assert.equal(res.writableEnded, true);
    assert.equal(unsubscribed, 1);
  }
});
