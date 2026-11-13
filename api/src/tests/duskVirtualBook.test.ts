import { marketLayoutVersion } from '../services/duskProtocolSchema';
import { createSdkTestRuntime } from './duskSdkTestRuntime';
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { BN } from '@coral-xyz/anchor';
import {
  Connection,
  RpcResponseAndContext,
  SimulatedTransactionResponse,
} from '@solana/web3.js';
import * as native from '../services/virtualBook/native';
import {
  createVirtualBookBoundary,
  decodePreviewSwapReturnData,
} from '../services/virtualBook/native';
import { computeExhausted, decodeDuskVirtualBookBatch, recoverExecutableVirtualBookQuotes, readDuskVirtualBookQuotes, unquotableAmount, type VirtualBookQuoteRequest } from '../services/virtualBook/virtual-book-quotes';
import { projectDuskVirtualBook } from '../services/virtualBook/virtual-book-view-model';
import { DuskVirtualBookSnapshot, readDuskVirtualBook } from '../services/virtualBook/virtual-book-read';
import {
  type Dusk,
} from '@omnipair/dusk-sdk';
import fixture from './fixtures/virtual-book-layout16.json';
import { currentVirtualBook, VirtualBookDependencies, VirtualBookEnvelope, virtualBookSelection } from '../services/duskVirtualBook';
import type { DuskDeploymentEnvelope } from '../services/duskDeploymentService';

const setup = async () => {
  const { dusk } = await createSdkTestRuntime(
    new Connection('http://localhost:8899'),
  );
  const account = dusk.program.coder.accounts.decode(
    'market',
    Buffer.from(fixture.result.value.accounts[0].data[0], 'base64'),
  );
  const snapshot = {
    market: fixture.market,
    account,
    deployment: { programId: fixture.programId },
    slot: fixture.result.context.slot,
  } as DuskVirtualBookSnapshot;
  const requests = fixture.result.value.logs
    .filter((line) => line.startsWith(`Program return: ${fixture.programId} `))
    .map((line) => ({
      side: 'bids' as const,
      amount: BigInt(
        decodePreviewSwapReturnData([
          line.split(' ')[3],
          'base64',
        ]).exactAssetIn.toString(),
      ),
    }));
  return { dusk, snapshot, requests };
};
test('native depth stays valid when preview banks run ahead of the stream', async () => {
  const deployment = {
    programId: fixture.programId,
    deploymentIdentitySha256: 'a'.repeat(64),
    sourceSlot: 100,
    programDataSlot: '1',
    leverageDelegateProgramDataSlot: '1',
  } as DuskDeploymentEnvelope;
  const floors: number[] = [];
  const previewFloors: number[] = [];
  const boundary = createVirtualBookBoundary(async floor => {
    floors.push(floor);
    return { ...deployment, sourceSlot: floor };
  });
  const dusk = {
    program: { programId: { toBase58: () => fixture.programId } },
    get: {
      previewVirtualBookSnapshot: async (_market: string, options: { minContextSlot: number }) => {
        previewFloors.push(options.minContextSlot);
        return { market: fixture.market, slot: 105, account: {} };
      },
      previewVirtualBookQuotes: async (_snapshot: unknown, options: { minContextSlot: number }) => {
        previewFloors.push(options.minContextSlot);
        return { slot: 107, quotes: [] };
      },
    },
  } as unknown as Dusk;
  const snapshot = await readDuskVirtualBook({ dusk, market: fixture.market, deployment, boundary });
  const quotes = await readDuskVirtualBookQuotes({ dusk, snapshot, boundary });
  assert.equal(quotes.slot, 107);
  assert.deepEqual(floors, [100, 105, 105, 107]);
  assert.deepEqual(previewFloors, [100, 105]);

  const changed = createVirtualBookBoundary(async floor => ({
    ...deployment,
    sourceSlot: floor,
    deploymentIdentitySha256: 'b'.repeat(64),
  }));
  await assert.rejects(
    readDuskVirtualBook({ dusk, market: fixture.market, deployment, boundary: changed }),
    /VOB deployment changed/,
  );
});
test('backend decodes the saved native batch with exact cumulative sizes and program fees', async () => {
  const h = await setup();
  const decoded = decodeDuskVirtualBookBatch(
    h.dusk,
    h.snapshot,
    h.requests,
    fixture.result as unknown as RpcResponseAndContext<SimulatedTransactionResponse>,
    h.snapshot.slot,
  );
  assert.equal(decoded.quotes.length, 4);
  const book = projectDuskVirtualBook({
    ...h.snapshot,
    account: decoded.market,
    groupingBps: 10,
    firstQuoteSlot: decoded.slot,
    mid: Number(decoded.quotes[0].preview.startPriceNad.toString()) / 1e9,
    quotes: { bids: decoded.quotes, asks: [] },
  })!;
  assert.equal(book.bids.length, 4);
  assert.ok(
    book.bids.every((row) => row.feePercent > 0 && row.averagePrice < book.mid),
  );
  assert.equal(
    decoded.quotes[3].preview.exactAssetIn.toString(),
    h.requests[3].amount.toString(),
  );
});
test('depth keeps only natively executable levels when a small cumulative quote breaks an invariant', async () => {
  const h = await setup();
  const { BN } = await import('@coral-xyz/anchor');
  const decoded = decodeDuskVirtualBookBatch(
    h.dusk,
    h.snapshot,
    h.requests,
    fixture.result as unknown as RpcResponseAndContext<SimulatedTransactionResponse>,
    h.snapshot.slot,
  );
  const broken = (code: number) => Object.assign(new Error('Dusk simulation failed'), {
    name: 'DuskSimulationError',
    simulation: { value: { err: { InstructionError: [2, { Custom: code }] } } },
  });
  assert.equal(unquotableAmount(broken(6047)), true);
  assert.equal(unquotableAmount(broken(999)), false);
  assert.equal(unquotableAmount(new Error('transport unavailable')), false);
  const rejected = new Set<bigint>();
  let calls = 0;
  const curve = {
    mid: 1,
    bids: Array.from({ length: 12 }, (_, index) => ({ total: index + 1, quoteTotal: index + 1 })),
    asks: Array.from({ length: 12 }, (_, index) => ({ total: index + 1, quoteTotal: index + 1 })),
  } as Parameters<typeof recoverExecutableVirtualBookQuotes>[3];
  const fake = {
    get: {
      previewVirtualBookBatch: async (
        _snapshot: unknown,
        batch: { side: 'bids' | 'asks'; amount: bigint }[],
      ) => {
        calls++;
        if (batch.length === 4 && batch[0].side === 'bids' && !rejected.size) {
          rejected.add(batch[0].amount);
          rejected.add(batch[1].amount);
          throw broken(6047);
        }
        if (batch.length === 1 && rejected.has(batch[0].amount))
          throw broken(6047);
        return {
          ...decoded,
          quotes: batch.map(request => ({
            ...decoded.quotes[0],
            side: request.side,
            preview: {
              ...decoded.quotes[0].preview,
              exactAssetIn: new BN(request.amount.toString()),
            },
          })),
        };
      },
    },
  } as unknown as Dusk;
  const quotes = await recoverExecutableVirtualBookQuotes(fake, h.snapshot, 10, curve, h.snapshot.slot);
  assert.equal(quotes.quotes.bids.length, 10);
  assert.equal(quotes.quotes.asks.length, 12);
  assert.equal(calls, 10); // six four-quote batches plus four single retries
  assert.ok(quotes.quotes.bids.every(quote =>
    !rejected.has(BigInt(quote.preview.exactAssetIn.toString())),
  ));

  const unrelated = {
    get: { previewVirtualBookBatch: async () => { throw broken(999); } },
  } as unknown as Dusk;
  await assert.rejects(
    recoverExecutableVirtualBookQuotes(unrelated, h.snapshot, 10, curve, h.snapshot.slot),
    /Dusk simulation failed/,
  );
});
const failedSimulation = (InstructionError: unknown[], logs: string[] = []) =>
  Object.assign(new Error('Dusk simulation failed'), {
    name: 'DuskSimulationError',
    simulation: { value: { err: { InstructionError }, logs } },
  });
// The tail of a four-quote batch on devnet market ogZU: each preview costs
// about 480k units, so the third runs out of the 1.4M transaction limit.
const outOfCompute = (instruction = 4) =>
  failedSimulation([instruction, 'ProgramFailedToComplete'], [
    `Program ${fixture.programId} invoke [1]`,
    'Program log: Instruction: PreviewSwap',
    `Program ${fixture.programId} consumed 438201 of 438257 compute units`,
    `Program ${fixture.programId} failed: exceeded CUs meter at BPF instruction`,
  ]);
const panicked = [`Program ${fixture.programId} failed: SBF program panicked`];
const wholeTokenCurve = {
  mid: 1,
  bids: Array.from({ length: 12 }, (_, index) => ({ total: index + 1, quoteTotal: index + 1 })),
  asks: Array.from({ length: 12 }, (_, index) => ({ total: index + 1, quoteTotal: index + 1 })),
} as Parameters<typeof recoverExecutableVirtualBookQuotes>[3];
const echoQuotes = (
  decoded: ReturnType<typeof decodeDuskVirtualBookBatch>,
  batch: VirtualBookQuoteRequest[],
) => ({
  ...decoded,
  quotes: batch.map(request => ({
    ...decoded.quotes[0],
    side: request.side,
    preview: {
      ...decoded.quotes[0].preview,
      exactAssetIn: new BN(request.amount.toString()),
    },
  })),
});
test('depth halves batches that run out of compute before giving up', async () => {
  const h = await setup();
  const decoded = decodeDuskVirtualBookBatch(
    h.dusk,
    h.snapshot,
    h.requests,
    fixture.result as unknown as RpcResponseAndContext<SimulatedTransactionResponse>,
    h.snapshot.slot,
  );
  assert.equal(computeExhausted(outOfCompute()), true);
  assert.equal(computeExhausted(failedSimulation([3, 'ComputationalBudgetExceeded'])), true);
  assert.equal(computeExhausted(failedSimulation([3, 'ProgramFailedToComplete'], panicked)), false);
  assert.equal(computeExhausted(failedSimulation([1, 'ComputationalBudgetExceeded'])), false);
  assert.equal(computeExhausted(failedSimulation([2, { Custom: 6047 }])), false);
  assert.equal(computeExhausted(new Error('exceeded CUs meter at BPF instruction')), false);
  assert.equal(unquotableAmount(outOfCompute()), false);

  const unit = 10n ** BigInt(h.snapshot.account.baseSide.assetDecimals);
  const sizes: number[] = [];
  const fake = {
    get: {
      previewVirtualBookBatch: async (_snapshot: unknown, batch: VirtualBookQuoteRequest[]) => {
        sizes.push(batch.length);
        if (batch.length > 2) throw outOfCompute();
        const rejected = batch.findIndex(request =>
          request.side === 'bids' && request.amount === 3n * unit);
        if (rejected >= 0) throw failedSimulation([2 + rejected, { Custom: 6047 }]);
        return echoQuotes(decoded, batch);
      },
    },
  } as unknown as Dusk;
  const quotes = await recoverExecutableVirtualBookQuotes(fake, h.snapshot, 10, wholeTokenCurve, h.snapshot.slot);
  assert.deepEqual(
    quotes.quotes.bids.map(quote => BigInt(quote.preview.exactAssetIn.toString())),
    [1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(level => BigInt(level) * unit),
  );
  assert.equal(quotes.quotes.asks.length, 12);
  // Six four-quote batches run out, their twelve halves fit, and the half
  // holding the unquotable level is retried one request at a time.
  const count = (size: number) => sizes.filter(length => length === size).length;
  assert.deepEqual([count(4), count(2), count(1)], [6, 12, 2]);

  sizes.length = 0;
  const heavy = {
    get: {
      previewVirtualBookBatch: async (_snapshot: unknown, batch: VirtualBookQuoteRequest[]) => {
        sizes.push(batch.length);
        throw outOfCompute(2);
      },
    },
  } as unknown as Dusk;
  await assert.rejects(
    recoverExecutableVirtualBookQuotes(heavy, h.snapshot, 10, wholeTokenCurve, h.snapshot.slot),
    /Dusk simulation failed/,
  );
  assert.ok(sizes.includes(1));
});
test('native depth recovers when the SDK quote batch runs out of compute', async () => {
  const h = await setup();
  const decoded = decodeDuskVirtualBookBatch(
    h.dusk,
    h.snapshot,
    h.requests,
    fixture.result as unknown as RpcResponseAndContext<SimulatedTransactionResponse>,
    h.snapshot.slot,
  );
  const deployment = {
    programId: fixture.programId,
    deploymentIdentitySha256: 'a'.repeat(64),
    sourceSlot: 100,
    programDataSlot: '1',
    leverageDelegateProgramDataSlot: '1',
  } as DuskDeploymentEnvelope;
  const boundary = createVirtualBookBoundary(async floor => ({ ...deployment, sourceSlot: floor }));
  const snapshot = { ...h.snapshot, deployment };
  let failure = outOfCompute();
  const sizes: number[] = [];
  const dusk = {
    program: { programId: { toBase58: () => fixture.programId } },
    get: {
      previewVirtualBookQuotes: async () => { throw failure; },
      previewVirtualBookBatch: async (_snapshot: unknown, batch: VirtualBookQuoteRequest[]) => {
        sizes.push(batch.length);
        if (batch.length > 2) throw outOfCompute();
        return echoQuotes(decoded, batch);
      },
    },
  } as unknown as Dusk;
  const projected = mock.method(native, 'projectDuskVirtualBookCurve', () => wholeTokenCurve);
  try {
    const quotes = await readDuskVirtualBookQuotes({ dusk, snapshot, boundary });
    assert.equal(quotes.quotes.bids.length, 12);
    assert.equal(quotes.quotes.asks.length, 12);
    assert.equal(sizes.length, 18); // six four-quote batches, then twelve halves

    // Any other failed preview still invalidates the book.
    failure = failedSimulation([4, 'ProgramFailedToComplete'], panicked);
    sizes.length = 0;
    await assert.rejects(readDuskVirtualBookQuotes({ dusk, snapshot, boundary }), /Dusk simulation failed/);
    assert.equal(sizes.length, 0);
  } finally {
    projected.mock.restore();
  }
});
test('a book is served at twelve, twenty-four or thirty-six levels a side and no other depth', () => {
  const market = fixture.market;
  assert.deepEqual(virtualBookSelection(market), {
    market,
    groupingBps: 10,
    levels: 12,
  });
  assert.equal(virtualBookSelection(market, '10', '24').levels, 24);
  assert.equal(virtualBookSelection(market, '25', '36').levels, 36);
  for (const levels of ['13', '48', '50', '0', 24, 'twelve', ''])
    assert.throws(() => virtualBookSelection(market, '10', levels), /Invalid virtual book selection/);
});
test('a deeper book samples the curve at its depth and prices every level natively', async () => {
  const h = await setup();
  const decoded = decodeDuskVirtualBookBatch(
    h.dusk,
    h.snapshot,
    h.requests,
    fixture.result as unknown as RpcResponseAndContext<SimulatedTransactionResponse>,
    h.snapshot.slot,
  );
  const deployment = {
    programId: fixture.programId,
    deploymentIdentitySha256: 'a'.repeat(64),
    sourceSlot: 100,
    programDataSlot: '1',
    leverageDelegateProgramDataSlot: '1',
  } as DuskDeploymentEnvelope;
  const boundary = createVirtualBookBoundary(async floor => ({ ...deployment, sourceSlot: floor }));
  const snapshot = { ...h.snapshot, deployment };
  let oneCall = 0;
  const sizes: number[] = [];
  const dusk = {
    program: { programId: { toBase58: () => fixture.programId } },
    get: {
      previewVirtualBookQuotes: async () => {
        oneCall++;
        throw new Error('the SDK samples twelve levels');
      },
      previewVirtualBookBatch: async (_snapshot: unknown, batch: VirtualBookQuoteRequest[]) => {
        sizes.push(batch.length);
        return echoQuotes(decoded, batch);
      },
    },
  } as unknown as Dusk;
  const deep = (levels: number) => ({
    mid: 1,
    bids: Array.from({ length: levels }, (_, index) => ({ total: index + 1, quoteTotal: index + 1 })),
    asks: Array.from({ length: levels }, (_, index) => ({ total: index + 1, quoteTotal: index + 1 })),
  }) as Parameters<typeof recoverExecutableVirtualBookQuotes>[3];
  const asked: unknown[][] = [];
  const projected = mock.method(native, 'projectDuskVirtualBookCurve', (...args: unknown[]) => {
    asked.push(args.slice(1));
    return deep(args[2] as number);
  });
  try {
    const quotes = await readDuskVirtualBookQuotes({ dusk, snapshot, boundary, groupingBps: 25, levels: 24 });
    assert.equal(oneCall, 0);
    assert.deepEqual(asked, [[25, 24]]);
    assert.equal(quotes.quotes.bids.length, 24);
    assert.equal(quotes.quotes.asks.length, 24);
    assert.equal(sizes.length, 12); // forty-eight levels in four-quote batches
  } finally {
    projected.mock.restore();
  }
});
test('each depth is cached apart', async () => {
  const deployment = {
    programId: fixture.programId,
    deploymentIdentitySha256: 'a'.repeat(64),
    sourceSlot: 100,
    programDataSlot: '1',
    leverageDelegateProgramDataSlot: '1',
  } as DuskDeploymentEnvelope;
  const keys: string[] = [];
  const deps = {
    envelope: async () => deployment,
    shared: async ({ key }: { key: string }) => {
      keys.push(key);
      return null;
    },
    capture: async () => {
      throw new Error('not captured');
    },
  } as unknown as VirtualBookDependencies;
  await currentVirtualBook(virtualBookSelection(fixture.market, '10'), deps);
  await currentVirtualBook(virtualBookSelection(fixture.market, '10', '24'), deps);
  assert.deepEqual(keys, [
    `virtual-book.v1:${'a'.repeat(64)}:${fixture.market}:10:12`,
    `virtual-book.v1:${'a'.repeat(64)}:${fixture.market}:10:24`,
  ]);
});
test('backend rejects old banks, wrong programs, truncated logs and changed input sizes', async () => {
  const h = await setup();
  const cases = [
    (f: typeof fixture.result) => {
      f.context.slot--;
    },
    (f: typeof fixture.result) => {
      f.value.returnData.programId = '11111111111111111111111111111111';
    },
    (f: typeof fixture.result) => {
      f.value.logs = [];
    },
    (f: typeof fixture.result) => {
      f.value.accounts[0].owner = '11111111111111111111111111111111';
    },
    (f: typeof fixture.result) => {
      f.value.accounts[4].data[0] = 'AA==';
    },
  ];
  for (const alter of cases) {
    const value = structuredClone(fixture.result);
    alter(value);
    assert.throws(() =>
      decodeDuskVirtualBookBatch(
        h.dusk,
        h.snapshot,
        h.requests,
        value as unknown as RpcResponseAndContext<SimulatedTransactionResponse>,
        h.snapshot.slot,
      ),
    );
  }
  assert.throws(() =>
    decodeDuskVirtualBookBatch(
      h.dusk,
      h.snapshot,
      h.requests.map((row) => ({ ...row, amount: row.amount + 1n })),
      fixture.result as unknown as RpcResponseAndContext<SimulatedTransactionResponse>,
      h.snapshot.slot,
    ),
  );
});
test('shared deliveries retain capture time and reject upgrades after cache lookup', async () => {
  const deployment = {
    deploymentIdentitySha256: 'a'.repeat(64),
    sourceSlot: 100,
  } as DuskDeploymentEnvelope;
  const result = {
    success: true,
    deployment,
    data: {
      observedAt: Date.now() - 1000,
      expiresAt: Date.now() + 10_000,
      sourceSlot: 100,
    },
  } as VirtualBookEnvelope;
  let calls = 0,
    upgraded = false;
  const deps = {
    envelope: async () => ({
      ...deployment,
      deploymentIdentitySha256:
        upgraded && ++calls > 1
          ? 'b'.repeat(64)
          : deployment.deploymentIdentitySha256,
    }),
    shared: async () => result,
    capture: async () => {
      throw new Error('Cache hit must not compute');
    },
  } as VirtualBookDependencies;
  const selection = virtualBookSelection(fixture.market, '10');
  const delivered = await currentVirtualBook(selection, deps);
  assert.equal(delivered?.data.observedAt, result.data.observedAt);
  upgraded = true;
  calls = 0;
  await assert.rejects(
    currentVirtualBook(selection, deps),
    /deployment changed/,
  );
  for (const grouping of ['0', '200', '10.0', 10, [], null])
    assert.throws(() => virtualBookSelection(fixture.market, grouping));
});
test('backend preserves nonlinear surcharge in marginal and cumulative depth', async () => {
  const h = await setup(),
    decoded = decodeDuskVirtualBookBatch(
      h.dusk,
      h.snapshot,
      h.requests,
      fixture.result as unknown as RpcResponseAndContext<SimulatedTransactionResponse>,
      h.snapshot.slot,
    );
  const { BN } = await import('@coral-xyz/anchor');
  const account = {
    ...h.snapshot.account,
    baseSide: { ...h.snapshot.account.baseSide, assetDecimals: 0 },
    quoteSide: { ...h.snapshot.account.quoteSide, assetDecimals: 0 },
  };
  const make = (
    input: number,
    output: number,
    fee: number,
    surcharge: number,
  ) => ({
    ...decoded.quotes[0],
    outputTransferFee: 0n,
    preview: {
      ...decoded.quotes[0].preview,
      exactAssetIn: new BN(input),
      amountOut: new BN(output),
      totalFeeRateNad: new BN(fee),
      divergenceFeeRateNad: new BN(surcharge),
      volatilityFeeRateNad: new BN(0),
    },
  });
  const book = projectDuskVirtualBook({
    ...h.snapshot,
    account,
    mid: 1,
    groupingBps: 10,
    firstQuoteSlot: h.snapshot.slot,
    quotes: {
      bids: [
        make(100, 98, 10_000_000, 7_000_000),
        make(200, 180, 80_000_000, 70_000_000),
      ],
      asks: [],
    },
  })!;
  assert.equal(book.bids[1].price, 0.82);
  assert.equal(book.bids[1].averagePrice, 0.9);
  assert.equal(book.bids[1].feePercent, 8);
  assert.equal(book.bids[1].surchargePercent, 7);
  assert.ok(Math.abs(book.bids[1].impactPercent - 10) < 1e-10);
});
