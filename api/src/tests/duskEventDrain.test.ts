import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { Pool } from 'pg';
import { coalescedDrain, drainOnEvents } from '../services/duskEventDrain';

test('wakes during a pass collapse into one more pass',async () => {
  let passes = 0,release!: () => void;
  let blocked = new Promise<void>(resolve => { release = resolve; });
  const pass = coalescedDrain(async () => { passes++; await blocked; });
  const first = pass.wake();
  assert.equal(pass.wake(),first);
  assert.equal(pass.wake(),first);
  blocked = Promise.resolve();
  release();
  await first;
  assert.equal(passes,2);
  await pass.wake();
  assert.equal(passes,3);
});

test('a failed pass rejects its wake and the next wake runs again',async () => {
  let passes = 0;
  const pass = coalescedDrain(async () => {
    passes++;
    if (passes === 1) throw new Error('invariant');
  });
  await assert.rejects(pass.wake(),/invariant/);
  await pass.wake();
  assert.equal(passes,2);
});

test('an invariant abort rejects the idle event loop and destroys its listening connection',async () => {
  const controller = new AbortController(),client = new EventEmitter();
  let released = false;
  Object.assign(client,{ query: async () => ({}),release: (destroy: boolean) => { released = destroy; } });
  const pool = { connect: async () => client } as unknown as Pool;
  const sigint = process.listenerCount('SIGINT'),sigterm = process.listenerCount('SIGTERM');
  await assert.rejects(drainOnEvents(pool,'test',async () => {
    controller.abort(new Error('FINALIZED_INVARIANT: corrupt history'));
  },controller.signal),/FINALIZED_INVARIANT/);
  assert.equal(released,true);
  assert.equal(process.listenerCount('SIGINT'),sigint); assert.equal(process.listenerCount('SIGTERM'),sigterm);
});

test('a previously aborted event loop never borrows a database connection',async () => {
  const controller = new AbortController(); controller.abort(new Error('stopped'));
  const pool = { connect: async () => { throw new Error('Unexpected connect'); } } as unknown as Pool;
  await assert.rejects(drainOnEvents(pool,'test',async () => {},controller.signal),/stopped/);
});
