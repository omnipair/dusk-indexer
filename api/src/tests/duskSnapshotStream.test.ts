import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';
import {
  createVirtualBookHub,
  openVirtualBookStream,
} from '../services/duskSnapshotStream';
import { VirtualBookEnvelope } from '../services/duskVirtualBook';
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const selection = {
  market: '11111111111111111111111111111111',
  groupingBps: 10,
};
function snapshot(revision = 'r1') {
  return {
    success: true,
    deployment: { deploymentIdentitySha256: 'a'.repeat(64) },
    data: { revision, expiresAt: Date.now() + 20_000 },
  } as VirtualBookEnvelope;
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
