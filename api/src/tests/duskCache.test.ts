import test from 'node:test';
import assert from 'node:assert/strict';
import { SimpleCache } from '../utils/cache';

test('committed changes detach old inflight reads and prevent stale cache repopulation', async () => {
  const cache = new SimpleCache();
  let finishOld!: (value: string) => void;
  const old = cache.getOrSet('dusk:market_health:test', 5_000, () => new Promise<string>((resolve) => { finishOld = resolve; }));
  cache.deleteByPrefix('dusk:market_health:');
  assert.equal(await cache.getOrSet('dusk:market_health:test', 5_000, async () => 'new'), 'new');
  finishOld('old');
  assert.equal(await old, 'old');
  assert.equal(cache.get('dusk:market_health:test'), 'new');
});

test('zero TTL coalesces concurrent requests without retaining the assembled response', async () => {
  const cache = new SimpleCache();
  let finish!: (value: string) => void;
  let calls = 0;
  const fetch = () => { calls++; return new Promise<string>((resolve) => { finish = resolve; }); };
  const first = cache.getOrSet('dusk:deployment_surface:test', 0, fetch);
  const second = cache.getOrSet('dusk:deployment_surface:test', 0, fetch);
  finish('snapshot');
  assert.deepEqual(await Promise.all([first, second]), ['snapshot', 'snapshot']);
  assert.equal(calls, 1);
  assert.equal(cache.get('dusk:deployment_surface:test'), null);
});
