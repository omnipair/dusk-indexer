import test from 'node:test';
import assert from 'node:assert/strict';
import { coalescedDrain } from '../services/duskEventDrain';

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
