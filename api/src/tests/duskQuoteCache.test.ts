import test from 'node:test';
import assert from 'node:assert/strict';
import { QuoteCache } from '../services/duskQuoteCache';

test('quote cache coalesces concurrent reads but never retains failures or invalidated in-flight work',async () => {
  const cache = new QuoteCache<number>(2,10_000);
  let resolve!: (value:number)=>void,calls=0;
  const load = () => { calls++; return new Promise<number>(done=>{ resolve=done; }); };
  const first = cache.get('identity:revision:window',load);
  const shared = cache.get('identity:revision:window',load);
  assert.equal(calls,1);
  cache.clear(); resolve(1);
  assert.deepEqual(await Promise.all([first,shared]),[1,1]);
  assert.equal(await cache.get('identity:revision:window',async()=>2),2);
  await assert.rejects(cache.get('failed',async()=>{ throw new Error('unavailable'); }));
  assert.equal(await cache.get('failed',async()=>3),3);
});
