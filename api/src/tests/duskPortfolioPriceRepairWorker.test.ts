import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import pool from '../config/database';
import { portfolioPriceRepairWake } from '../services/duskPortfolioPriceRepairWorker';

after(() => pool.end());
const result = { examinedCaptures: 0,repairedCheckpoints: 0,unresolvedCheckpoints: 0,
  providerRequests: 0,providerFailures: 0,cachedPoints: 0,dryRun: false,busy: false };
test('idle wakes repair immediately and at most once per five minutes',async () => {
  let now = 1_000,calls = 0;
  const wake = portfolioPriceRepairWake({ now: () => now,repair: async () => { calls++; return result; } });
  await wake(); await wake(); now += 299_999; await wake(); assert.equal(calls,1);
  now++; await wake(); assert.equal(calls,2);
});
test('a transient repair failure retries later without disabling live price refresh',async t => {
  t.mock.method(console,'warn',() => {});
  let now = 1,calls = 0;
  const wake = portfolioPriceRepairWake({ now: () => now,repair: async () => { calls++; if (calls === 1) throw new Error('provider unavailable'); return result; } });
  await wake(); now += 300_000; await wake(); assert.equal(calls,2);
});
test('contradictory saved evidence halts instead of being classified as a provider outage',async () => {
  const wake = portfolioPriceRepairWake({ repair: async () => { throw new Error('FINALIZED_INVARIANT: corrupt source'); } });
  await assert.rejects(wake(),/FINALIZED_INVARIANT/);
});
