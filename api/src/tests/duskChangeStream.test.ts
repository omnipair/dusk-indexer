import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';
import { loadPinnedProtocol } from '../config/duskProtocol';
import { parseDuskReadChange, publishDuskReadChange, subscribeDuskReadChanges, DuskReadChange } from '../services/duskChangeBus';
import { openDuskChangeStream, DUSK_CHANGE_STREAM_OBSERVATION_TIMEOUT_MS } from '../services/duskChangeStream';
import type { DuskDeploymentEnvelope } from '../services/duskDeploymentService';

const pin = loadPinnedProtocol();
test('database hints require a complete active identity and a valid release slot', () => {
  const valid = { cluster: pin.cluster, programId: pin.dusk.programId, idlHash: pin.dusk.idlCanonicalSha256,
    protocolRevision: pin.revision, slot: pin.historyFirstSlot };
  assert.deepEqual(parseDuskReadChange(JSON.stringify(valid)), { kind: 'change', sourceSlot: pin.historyFirstSlot });
  for (const patch of [{ cluster: 'mainnet-beta' }, { programId: 'wrong' }, { idlHash: '0'.repeat(64) },
    { protocolRevision: 'old' }, { slot: pin.historyFirstSlot - 1 }, { slot: null }, { slot: '1' },
    { slot: Number.MAX_SAFE_INTEGER + 1 }, { slot: 1.5 }])
    assert.equal(parseDuskReadChange(JSON.stringify({ ...valid, ...patch })), null);
  for (const invalid of ['null', '[]', '{', 'x'.repeat(8193), undefined]) assert.equal(parseDuskReadChange(invalid), null);
});

test('a failed subscriber cannot suppress other subscribers and unsubscribe releases it', () => {
  let seen = 0;
  const a = subscribeDuskReadChanges(() => { throw new Error('closed'); });
  const b = subscribeDuskReadChanges(() => { seen++; });
  publishDuskReadChange({ kind: 'resync', sourceSlot: 0 });
  a(); b();
  publishDuskReadChange({ kind: 'resync', sourceSlot: 0 });
  assert.equal(seen, 1);
});

class Sink extends EventEmitter {
  writableEnded = false;
  writable = true;
  headersSent = false;
  frames: Array<{ data: { kind: string; sequence: number; sourceSlot: number; streamId: string }; deployment: DuskDeploymentEnvelope }> = [];
  status() { return this; }
  set() { return this; }
  flushHeaders() { this.headersSent = true; }
  write(value: string) { this.frames.push(JSON.parse(value.split('\ndata: ')[1])); return this.writable; }
  end() { this.writableEnded = true; }
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function harness() {
  const req = new EventEmitter(), res = new Sink();
  let listener: ((change: DuskReadChange) => void) | undefined;
  let ready = true, identity = 'a'.repeat(64);
  const floors: number[] = [];
  const deps = {
    start: async (): Promise<void> => undefined,
    ready: () => ready,
    envelope: async (slot: number) => {
      floors.push(slot);
      return { deploymentIdentitySha256: identity, sourceSlot: Math.max(slot, pin.historyFirstSlot) } as DuskDeploymentEnvelope;
    },
    subscribe: (fn: (change: DuskReadChange) => void) => { listener = fn; return () => { listener = undefined; }; },
  };
  return { req, res, deps, floors, open: () => openDuskChangeStream(req as Request, res as unknown as Response, deps),
    emit: (change: DuskReadChange) => listener?.(change), close: () => res.emit('close'),
    upgrade: () => { identity = 'b'.repeat(64); }, offline: () => { ready = false; }, subscribed: () => Boolean(listener) };
}

test('a connection starts with resync and heartbeats retain monotonic sequence', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 100_000 });
  const h = harness(); t.after(h.close); await h.open();
  assert.equal(h.res.frames[0].data.kind, 'resync');
  t.mock.timers.tick(15_000); await flush(); t.mock.timers.tick(0); await flush();
  assert.equal(h.res.frames[1].data.kind, 'heartbeat');
  assert.equal(h.res.frames[1].data.sequence, 2);
  assert.equal(h.res.frames[1].data.streamId, h.res.frames[0].data.streamId);
});

test('notification bursts coalesce with their highest source-slot floor', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 100_000 });
  const h = harness(); t.after(h.close); await h.open();
  h.emit({ kind: 'change', sourceSlot: pin.historyFirstSlot + 1 });
  h.emit({ kind: 'change', sourceSlot: pin.historyFirstSlot + 9 });
  t.mock.timers.tick(4999); await flush(); assert.equal(h.res.frames.length, 1);
  t.mock.timers.tick(1); await flush();
  assert.equal(h.res.frames.length, 2);
  assert.equal(h.res.frames[1].data.sourceSlot, pin.historyFirstSlot + 9);
  assert.equal(h.floors.at(-1), pin.historyFirstSlot + 9);
});

test('listener failure ends the stream instead of leaving a false healthy subscription', async t => {
  const h = harness(); t.after(h.close); await h.open();
  h.offline(); h.emit({ kind: 'unavailable', sourceSlot: 0 });
  assert.equal(h.res.writableEnded, true); assert.equal(h.subscribed(), false);
});

test('an upgrade never emits a frame under the previous connection identity', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 100_000 });
  const h = harness(); t.after(h.close); await h.open(); h.upgrade();
  h.emit({ kind: 'change', sourceSlot: pin.historyFirstSlot });
  t.mock.timers.tick(5000); await flush();
  assert.equal(h.res.frames.length, 1); assert.equal(h.res.writableEnded, true);
});

test('disconnect during the initial observation cannot write headers or retain a subscriber', async () => {
  const h = harness();
  let release!: () => void;
  h.deps.start = () => new Promise<void>(resolve => { release = resolve; });
  const opening = h.open(); h.req.emit('aborted'); release(); await opening;
  assert.equal(h.res.headersSent, false); assert.equal(h.subscribed(), false);
});

test('backpressure closes a slow client without buffering more frames', async () => {
  const h = harness(); h.res.writable = false; await h.open();
  assert.equal(h.res.frames.length, 1); assert.equal(h.res.writableEnded, true); assert.equal(h.subscribed(), false);
});

test('a hung initial observation releases the connection and subscriber at its deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 100_000 });
  const h = harness();
  h.deps.envelope = () => new Promise(() => undefined);
  const opening = assert.rejects(h.open(), /Native change stream unavailable/);
  await flush();
  t.mock.timers.tick(DUSK_CHANGE_STREAM_OBSERVATION_TIMEOUT_MS); await flush(); await opening;
  assert.equal(h.subscribed(), false); assert.equal(h.res.headersSent, false);
});

test('a timed-out heartbeat closes the stream and ignores its late observation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 100_000 });
  const h = harness(); t.after(h.close); await h.open();
  let release!: (value: DuskDeploymentEnvelope) => void;
  h.deps.envelope = () => new Promise(resolve => { release = resolve; });
  t.mock.timers.tick(15_000); await flush(); t.mock.timers.tick(0); await flush();
  t.mock.timers.tick(DUSK_CHANGE_STREAM_OBSERVATION_TIMEOUT_MS); await flush();
  assert.equal(h.res.writableEnded, true); assert.equal(h.subscribed(), false);
  release(h.res.frames[0].deployment); await flush();
  assert.equal(h.res.frames.length, 1);
});
