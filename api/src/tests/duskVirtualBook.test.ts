import { createSdkTestRuntime } from './duskSdkTestRuntime';
import test from 'node:test';
import assert from 'node:assert/strict';
import { BorshAccountsCoder, BN } from '@coral-xyz/anchor';
import {
  Connection,
  RpcResponseAndContext,
  SimulatedTransactionResponse,
} from '@solana/web3.js';
import {
  createVirtualBookBoundary,
  decodePreviewSwapReturnData,
} from '../services/virtualBook/native';
import { decodeDuskVirtualBookBatch, recoverExecutableVirtualBookQuotes, readDuskVirtualBookQuotes, unquotableAmount } from '../services/virtualBook/virtual-book-quotes';
import { projectDuskVirtualBook } from '../services/virtualBook/virtual-book-view-model';
import { DuskVirtualBookSnapshot, readDuskVirtualBook } from '../services/virtualBook/virtual-book-read';
import {
  MARKET_LAYOUT_VERSION,
  type Dusk,
} from '@omnipair/dusk-sdk';
import fixture from './fixtures/virtual-book-batch-devnet-20260920.json';
import {
  currentVirtualBook,
  VirtualBookDependencies,
  VirtualBookEnvelope,
  virtualBookSelection,
} from '../services/duskVirtualBook';
import type { DuskDeploymentEnvelope } from '../services/duskDeploymentService';

// This immutable devnet capture predates the current market layout. Adapt the
// saved bytes through the explicit historical schema so the fixture continues
// to test its original quotes instead of pretending an old account is v6.
let fixtureAdaptation: Promise<void> | undefined;
const adaptFixture = (program: Dusk['program']) =>
  (fixtureAdaptation ??= (async () => {
  const saved = Buffer.from(
    fixture.result.value.accounts[0].data[0],
    'base64',
  );
  assert.equal(saved.length, 2917);
  const borrowIndexEnd = 1623;
  const withCarries = Buffer.concat([
    saved.subarray(0, borrowIndexEnd),
    Buffer.alloc(32),
    saved.subarray(borrowIndexEnd),
  ]);
  const debtEnd = borrowIndexEnd + 32 + 128;
  const withExposure = Buffer.concat([
    withCarries.subarray(0, debtEnd),
    Buffer.alloc(16),
    withCarries.subarray(debtEnd),
  ]);
  const baseFeesOffset = 250;
  const quoteFeesOffset = 755;
  const layout3 = Buffer.concat([
    withExposure.subarray(0, baseFeesOffset),
    Buffer.alloc(32),
    withExposure.subarray(baseFeesOffset, quoteFeesOffset),
    Buffer.alloc(32),
    withExposure.subarray(quoteFeesOffset),
  ]);
  layout3[8] = 3;

  const oldIdl: any = structuredClone(program.idl);
  for (const type of oldIdl.types ?? []) {
    if (!('fields' in type.type) || !type.type.fields) continue;
    type.type.fields = type.type.fields.filter(
      (field: any) =>
        ![
          'flashReceivable',
          'flashCollateralDebit',
          'frozenHlpMask',
          'frozenBaseVaultBaseOffsetNad',
          'frozenBaseVaultQuoteOffsetNad',
          'frozenQuoteVaultBaseOffsetNad',
          'frozenQuoteVaultQuoteOffsetNad',
        ].includes(field.name) &&
        !(type.name === 'insuranceDrawWindow' && field.name === 'initialized'),
    );
  }
  const oldAccount = new BorshAccountsCoder(oldIdl).decode(
    'market',
    layout3,
  ) as any;
  oldAccount.version = MARKET_LAYOUT_VERSION;
  oldAccount.baseSide.reserves.flashReceivable = new BN(0);
  oldAccount.quoteSide.reserves.flashReceivable = new BN(0);
  oldAccount.baseHlpVault.flashCollateralDebit = new BN(0);
  oldAccount.quoteHlpVault.flashCollateralDebit = new BN(0);
  Object.assign(oldAccount.amm, {
    frozenHlpMask: 0,
    frozenBaseVaultBaseOffsetNad: new BN(0),
    frozenBaseVaultQuoteOffsetNad: new BN(0),
    frozenQuoteVaultBaseOffsetNad: new BN(0),
    frozenQuoteVaultQuoteOffsetNad: new BN(0),
  });
  oldAccount.insurance.baseDrawWindow.initialized = false;
  oldAccount.insurance.quoteDrawWindow.initialized = false;
  const body = Buffer.alloc(layout3.length + 128),
    entry = (program.coder.accounts as any).accountLayouts.get('market'),
    size = entry.layout.encode(oldAccount, body);
  fixture.result.value.accounts[0].data[0] = Buffer.concat([
    layout3.subarray(0, 8),
    body.subarray(0, size),
  ]).toString('base64');

  const prefix = `Program return: ${fixture.programId} `;
  const currentPreviewBytes = (encoded: string) => {
    const old = Buffer.from(encoded, 'base64'),
      added = Buffer.alloc(16);
    added.writeBigUInt64LE(old.readBigUInt64LE(27), 8);
    return Buffer.concat([old, added]).toString('base64');
  };
  fixture.result.value.logs = fixture.result.value.logs.map((line) =>
    line.startsWith(prefix)
      ? prefix + currentPreviewBytes(line.slice(prefix.length))
      : line,
  );
  fixture.result.value.returnData.data[0] = currentPreviewBytes(
    fixture.result.value.returnData.data[0],
  );
})());

const setup = async () => {
  const { dusk } = await createSdkTestRuntime(
    new Connection('http://localhost:8899'),
  );
  await adaptFixture(dusk.program);
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
