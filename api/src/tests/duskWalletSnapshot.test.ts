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
    lpPerformance: async () => [],
    cashFlows: async (_owner, positions, sourceSlot) => positions.map(p=>({address:p.address,market:p.market,
      openedSlot:p.openedSlot,sourceSlot,status:'unavailable',reason:'history-unavailable'})),
    accounts: async () => accounts,
    oracle: async (_dusk, rows, deployment) => rows.map(row => ({
      address: row.address, market: f.marketAddress.toBase58(), sourceSlot: deployment.sourceSlot,
      status: 'unavailable' as const, reason: 'oracle-unavailable' as const,
    })),
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
    borrowPositions: async () => ({ positions: [], sourceSlot: 1010 }),
    borrowValuation: walletCaptureDependencies.borrowValuation,
    hlpBalances: async () => ({ balances: [], lpBalances: [], sourceSlot: 1010 }),
    juniorExits: async () => ({ positions: [], sourceSlot: 1010 }),
    hlpPositions: walletCaptureDependencies.hlpPositions,
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

test('auxiliary LP history is bounded by the original streamed wallet observation', async () => {
  const f = await fixture();
  const payloadObservedAt = Date.now() - 100;
  let historyObservation: string | undefined;
  f.deps.lpPerformance = async (_owner, _balances, deployment) => {
    historyObservation = deployment.observedAt;
    return [];
  };
  const result = await captureWalletSnapshot(f.dusk, {} as DuskReadBoundary,
    f.selection.owner, f.deployment, undefined, f.deps, payloadObservedAt);
  assert.equal(result.observedAt, payloadObservedAt);
  assert.equal(historyObservation, new Date(result.observedAt).toISOString());
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

test('streamed holdings discovery does not wait for wallet RPC inventory', async () => {
  const f = await fixture();
  let release!: () => void;
  const inventory = new Promise<void>(resolve => { release = resolve; });
  const started: string[] = [];
  let reads = 0;
  f.deps.accounts = async () => {
    if (++reads === 1) await inventory;
    return f.capturedAccounts;
  };
  for (const key of ['borrowPositions', 'hlpBalances', 'juniorExits'] as const) {
    const read = f.deps[key];
    Object.assign(f.deps, { [key]: async (...args: never[]) => {
      started.push(key);
      return (read as (...values: never[]) => Promise<unknown>)(...args);
    } });
  }
  const batch = f.capture();
  await pause();
  assert.deepEqual(started.sort(), ['borrowPositions', 'hlpBalances', 'juniorExits']);
  release();
  assert.equal((await batch).complete, true);
});

test('LP history overlaps live valuations but remains inside the atomic wallet batch', async () => {
  const f = await fixture();
  let releaseValuation!: () => void, releaseHistory!: () => void;
  let historyStarted = false, published = false;
  const valuation = new Promise<void>(resolve => { releaseValuation = resolve; });
  const history = new Promise<void>(resolve => { releaseHistory = resolve; });
  f.deps.valuation = async () => { await valuation; return f.valuation; };
  f.deps.lpPerformance = async () => { historyStarted = true; await history; return []; };
  const batch = f.capture().then(value => { published = true; return value; });
  await pause();
  assert.equal(historyStarted, true);
  assert.equal(published, false);
  releaseValuation();
  await pause();
  assert.equal(published, false);
  releaseHistory();
  assert.equal((await batch).complete, true);
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

test('an incomplete oracle batch cannot be published as a complete wallet frame', async () => {
  const f = await fixture();
  f.deps.oracle = async () => [];
  await assert.rejects(f.capture(), /oracle valuation batch is incomplete/);
});

test('cash-flow history failure leaves positions and debt available with explicit unknown PnL', async () => {
  const f = await fixture();
  f.deps.cashFlows = async () => {throw new Error('history database unavailable');};
  const batch = await f.capture();
  assert.equal(batch.accounts.accounts.length,1);
  assert.equal(batch.valuations.length,1);
  assert.equal(batch.cashFlows[0].status,'unavailable');
});

test('wallet frames value streamed borrow positions at or after the stream and cover every preview slot', async () => {
  const f = await fixture();
  const position = { address: displayKey(95).toBase58(), market: f.marketAddress.toBase58(), owner: f.selection.owner };
  f.deps.borrowPositions = async (selection) => {
    assert.deepEqual(selection, { owner: f.selection.owner });
    return { positions: [position], sourceSlot: 1020 };
  };
  f.deps.borrowValuation = async (_dusk, row, floor) => {
    assert.equal(floor, 1020);
    return { status: 'unavailable', ...row, sourceSlot: 1030, reason: 'preview-rejected' };
  };
  const hlp = {
    market: f.marketAddress.toBase58(), side: 'quote' as const, hlpMint: displayKey(96).toBase58(), walletBalance: '7',
    protectedBalance: '0', hasStopLoss: false, hasStopRate: false, principalNavPerTokenNad: '1000000000', sourceSlot: 1040,
  };
  f.deps.hlpBalances = async () => ({ balances: [{ market: hlp.market, side: 'quote', hlpMint: hlp.hlpMint, amount: '7' }],
    lpBalances: [{ market: hlp.market, kind: 'quote_hlp', lpMint: hlp.hlpMint, amount: '7' }], sourceSlot: 1015 });
  f.deps.hlpPositions = async (_dusk, holdings, orders, payer, minSlot) => {
    assert.equal(holdings.length, 1);
    assert.deepEqual(orders, []);
    assert.equal(payer, f.deployment.programUpgradeAuthority);
    assert.equal(minSlot, 1015);
    return [hlp];
  };
  const result = await f.capture();
  assert.deepEqual(result.borrowValuations, [{ status: 'unavailable', ...position, sourceSlot: 1030, reason: 'preview-rejected' }]);
  assert.deepEqual(result.hlpPositions, [hlp]);
  assert.deepEqual(result.lpBalances, { basis: 'streamed-events.v1', sourceSlot: 1015,
    balances: [{ market: hlp.market, kind: 'quote_hlp', lpMint: hlp.hlpMint, amount: '7' }] });
  assert.equal(result.sourceSlot, 1040);
  f.deps.borrowValuation = async () => {
    throw new Error('RPC timeout');
  };
  await assert.rejects(f.capture(), /RPC timeout/);
});
