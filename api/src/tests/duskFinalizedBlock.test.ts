import test from 'node:test';
import assert from 'node:assert/strict';
import { readFinalizedBlock } from '../services/duskFinalizedBlock';

const block = { blockhash: 'source-block',parentSlot: 99,blockTime: 1789317000 };

test('temporary block-history lag retries the same finalized bank without changing its timestamp',async () => {
  const calls: number[] = [],delays: number[] = [];
  const result = await readFinalizedBlock({ getBlock: async (slot,config) => {
    calls.push(slot);
    assert.equal(config.commitment,'finalized');
    assert.equal(config.transactionDetails,'none');
    if (calls.length === 1) throw Object.assign(new Error('Block not available'),{ code: -32004 });
    if (calls.length === 2) return null;
    if (calls.length === 3) return { ...block,blockTime: null };
    return block;
  } },100,async (delay) => { delays.push(delay); });
  assert.deepEqual(calls,[100,100,100,100]);
  assert.deepEqual(delays,[500,1000,1500]);
  assert.deepEqual(result,block);
});

test('unavailable source history fails after bounded retries instead of inventing a block time',async () => {
  const calls: number[] = [];
  await assert.rejects(readFinalizedBlock({ getBlock: async (slot) => {
    calls.push(slot);
    return { ...block,blockTime: NaN };
  } },100,async () => {}),/unavailable/);
  assert.deepEqual(calls,[100,100,100,100]);
});

test('unsafe source slots are rejected before contacting RPC',async () => {
  await assert.rejects(readFinalizedBlock({ getBlock: async () => { assert.fail('RPC must not run'); } },Number.MAX_SAFE_INTEGER+1),/Invalid finalized source slot/);
});
