import test from 'node:test';
import assert from 'node:assert/strict';
import { failureReason, runPortfolioCaptures } from '../services/duskPortfolioWorker';

const STALE = 'The Dusk stream is stale; portfolio discovery is not current';
const quiet = (t: test.TestContext) => {
  t.mock.method(console,'log',() => {});
  return t.mock.method(console,'warn',() => {});
};

test('a stale stream skips the cycle and the next interval captures',async (t) => {
  const warn = quiet(t);
  let captures = 0,sleeps = 0;
  await runPortfolioCaptures({
    replay: async () => 0,
    capture: async () => { captures++; if (captures === 1) throw new Error(STALE); return { captureId: '1' }; },
    intervalMs: 60_000,once: false,replayOnly: false,stopped: () => captures === 2,
    sleep: async () => { sleeps++; },
  });
  assert.equal(captures,2);
  assert.equal(sleeps,2);
  assert.equal(warn.mock.callCount(),1);
  assert.deepEqual(warn.mock.calls[0].arguments[1],{ reason: STALE });
});

test('a failed replay is retried on the next interval too',async (t) => {
  quiet(t);
  let replays = 0,captures = 0;
  await runPortfolioCaptures({
    replay: async () => { replays++; if (replays === 1) throw new Error('connect ECONNREFUSED'); return 0; },
    capture: async () => { captures++; return {}; },
    intervalMs: 60_000,once: false,replayOnly: false,stopped: () => captures === 1,sleep: async () => {},
  });
  assert.equal(replays,2);
  assert.equal(captures,1);
});

test('contradictory saved evidence stops the worker',async (t) => {
  quiet(t);
  await assert.rejects(runPortfolioCaptures({
    replay: async () => { throw new Error('FINALIZED_INVARIANT: contradictory finalized portfolio account evidence'); },
    capture: async () => ({}),intervalMs: 60_000,once: false,replayOnly: false,stopped: () => false,sleep: async () => {},
  }),/FINALIZED_INVARIANT/);
});

test('one-shot runs report a failed cycle',async (t) => {
  quiet(t);
  const stale = async () => { throw new Error(STALE); };
  await assert.rejects(runPortfolioCaptures({ replay: async () => 0,capture: stale,intervalMs: 60_000,
    once: true,replayOnly: false,stopped: () => false,sleep: async () => {} }),/stale/);
  await assert.rejects(runPortfolioCaptures({ replay: stale,capture: async () => ({}),intervalMs: 60_000,
    once: false,replayOnly: true,stopped: () => false,sleep: async () => {} }),/stale/);
});

test('the logged reason never carries an endpoint key or credentials',() => {
  const rpc = failureReason(new Error('request to https://devnet.helius-rpc.com/?api-key=secret-key failed, reason: socket hang up'));
  assert.equal(rpc,'request to https://devnet.helius-rpc.com/?… failed, reason: socket hang up');
  const db = failureReason(new Error('cannot reach postgresql://dusk:hunter2@db.internal:5432/dusk'));
  assert.equal(db,'cannot reach postgresql://…@db.internal:5432/dusk');
  assert.equal(failureReason('plain'),'plain');
});
