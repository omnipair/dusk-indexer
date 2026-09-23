import test from 'node:test';
import assert from 'node:assert/strict';
import {
  captureWalletSnapshot,
  completeBatch,
  walletCaptureDependencies,
} from '../services/duskWalletSnapshot';
import { captureOwnerAccounts } from '../services/duskOwnerAccounts';
import {
  captureLeverageValuation,
  DuskLeverageValuationUnavailable,
} from '../services/duskLeverageValuation';
import { captureMarketExposures } from '../services/duskStatisticsSnapshot';
import { displayFixture, displayKey } from './duskDisplayStateFixtures';
import type { DuskReadBoundary } from '../services/virtualBook/native';
const pause = () => new Promise<void>((resolve) => setImmediate(resolve));

test('a batch publishes once after the slowest row, preserving row order', async () => {
  const releases: (() => void)[] = [];
  let published = false;
  const batch = completeBatch([0, 1, 2], async (n) => {
    await new Promise<void>((resolve) => {
      releases[n] = resolve;
    });
    return n * 10;
  }).then((rows) => {
    published = true;
    return rows;
  });
  releases[2]();
  releases[0]();
  await pause();
  assert.equal(published, false);
  releases[1]();
  assert.deepEqual(await batch, [0, 10, 20]);
});

test('failed batches stop queued work and drain in-flight reads before retry', async () => {
  let release!: () => void,
    settled = false;
  const started: number[] = [];
  const batch = completeBatch(
    [0, 1, 2, 3],
    async (n) => {
      started.push(n);
      if (n === 0) throw new Error('network unavailable');
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return n;
    },
    2,
  ).catch((error) => {
    settled = true;
    throw error;
  });
  await pause();
  assert.equal(settled, false);
  assert.deepEqual(started, [0, 1]);
  release();
  await assert.rejects(batch, /network unavailable/);
  await assert.rejects(
    completeBatch([], async (n) => n, 0),
    /concurrency/,
  );
});

async function fixture() {
  const f = await displayFixture();
  const accounts = await captureOwnerAccounts(
    f.dusk,
    { owner: f.selection.owner, kind: 'leverage' },
    f.deployment,
  );
  const valuation = await captureLeverageValuation(
    f.dusk,
    f.selection,
    f.deployment,
  );
  const deps: typeof walletCaptureDependencies = {
    accounts: async () => accounts,
    valuation: async () => valuation,
    orders: async () => ({
      owner: f.selection.owner,
      deployment: f.deployment,
      observedAt: Date.now(),
      slot: 1010,
      exit: [],
      entry: [],
      hlp: [],
    }),
  };
  const capture = () =>
    captureWalletSnapshot(
      f.dusk,
      {} as DuskReadBoundary,
      f.selection.owner,
      f.deployment,
      undefined,
      deps,
    );
  return { ...f, deps, capture, capturedAccounts: accounts, valuation };
}

test('wallet positions, exact quotes and orders share one complete bounded revision', async () => {
  const f = await fixture(),
    result = await f.capture();
  assert.equal(result.owner, f.selection.owner);
  assert.equal(result.valuations.length, 1);
  assert.equal(result.valuations[0], f.valuation);
  assert.equal(result.orders.owner, result.owner);
  assert.equal(result.expiresAt - result.observedAt, 15000);
  assert.equal(result.accounts, f.capturedAccounts);
});

test('program-rejected quotes are explicit unavailable rows; transport errors reject the batch', async () => {
  const f = await fixture();
  f.deps.valuation = async () => {
    throw new DuskLeverageValuationUnavailable(f.selection.address, 1010);
  };
  const batch = await f.capture();
  assert.equal(batch.accounts.accounts.length, 1);
  assert.deepEqual(batch.valuations, [
    {
      status: 'unavailable',
      address: f.selection.address,
      sourceSlot: 1010,
      reason: 'close-rejected',
    },
  ]);
  f.deps.valuation = async () => {
    throw new Error('RPC timeout');
  };
  await assert.rejects(f.capture(), /RPC timeout/);
});

test('wallet batches reject changed inventory and mismatched valuation amounts', async () => {
  const f = await fixture();
  let reads = 0;
  f.deps.accounts = async () =>
    ++reads === 1
      ? f.capturedAccounts
      : { ...f.capturedAccounts, accounts: [] };
  await assert.rejects(f.capture(), /positions changed/);
  f.deps.accounts = async () => f.capturedAccounts;
  f.valuation.position.marginRaw = '999';
  await assert.rejects(f.capture(), /valuation changed/);
});

test('only a confirmed close instruction rejection is classified as unavailable', async () => {
  const f = await displayFixture();
  f.state.err = { InstructionError: [4, { Custom: 6001 }] };
  await assert.rejects(
    captureLeverageValuation(f.dusk, f.selection, f.deployment),
    DuskLeverageValuationUnavailable,
  );
  f.state.err = { InstructionError: [2, { Custom: 6001 }] };
  await assert.rejects(
    captureLeverageValuation(f.dusk, f.selection, f.deployment),
    (error) => !(error instanceof DuskLeverageValuationUnavailable),
  );
});

test('exposure capture groups verified collateral and rejects malformed or regressed accounts', async () => {
  const f = await displayFixture();
  f.position.bump = f.dusk.get.pda.leveragePosition(
    f.marketAddress,
    f.position.positionId,
  )[1];
  f.state.discovered[0].account = f.encodeAccount(
    'leveragePosition',
    f.position,
  );
  const result = await captureMarketExposures(f.dusk, f.deployment);
  assert.deepEqual(result.markets, [
    {
      market: f.marketAddress.toBase58(),
      baseCollateral: '100',
      quoteCollateral: '0',
      positions: 1,
    },
  ]);
  f.state.discovered[0].pubkey = displayKey(99);
  await assert.rejects(
    captureMarketExposures(f.dusk, f.deployment),
    /Invalid exposure/,
  );
  f.state.slot = 999;
  await assert.rejects(
    captureMarketExposures(f.dusk, f.deployment),
    /Incomplete/,
  );
});
