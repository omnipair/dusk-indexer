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


test('history cache reports hit/miss/shared outcomes and evicts expired entries', async () => {
  const cache = new QuoteCache<number>(1,10_000);
  let resolve!: (value:number)=>void;
  const first = cache.getWithMeta('a',()=>new Promise<number>(done=>{resolve=done;}));
  const shared = cache.getWithMeta('a',async()=>99);
  resolve(1);
  assert.equal((await first).cacheStatus,'miss');
  assert.equal((await shared).cacheStatus,'coalesced');
  assert.equal((await cache.getWithMeta('a',async()=>99)).cacheStatus,'hit');
  await cache.getWithMeta('b',async()=>2,0);
  assert.equal((await cache.getWithMeta('b',async()=>3)).data,3);
  assert.equal((await cache.getWithMeta('a',async()=>4)).cacheStatus,'miss');
});
