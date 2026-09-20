/** Read-only devnet proof. DATABASE_URL must name a disposable local database
 * containing migration 043. No wallet signs or broadcasts a transaction.
 */
import assert from 'node:assert/strict';
import express from 'express';
import { writeFileSync } from 'node:fs';
import { PublicKey } from '@solana/web3.js';
import {
  calculateEpochFee,
  getMint,
  getTransferFeeConfig,
} from '@solana/spl-token';
import pool from '../config/database';
import {
  createVirtualBookHub,
  openVirtualBookStream,
  stopDuskSnapshotStreams,
} from '../services/duskSnapshotStream';
import {
  captureVirtualBook,
  currentVirtualBook,
  VirtualBookEnvelope,
} from '../services/duskVirtualBook';
import { deploymentEnvelope } from '../services/duskDeploymentService';
import { sharedDuskSnapshot } from '../services/duskSharedSnapshot';
import { createVirtualBookRuntime, BN } from '../services/virtualBook/native';

async function main() {
  const market = process.env.DUSK_PROBE_MARKET;
  assert.ok(market, 'DUSK_PROBE_MARKET is required');
  let captures = 0;
  const hub = createVirtualBookHub((selection) =>
    currentVirtualBook(selection, {
      envelope: deploymentEnvelope,
      shared: sharedDuskSnapshot,
      capture: async (...args) => {
        captures++;
        return captureVirtualBook(...args);
      },
    }),
  );
  const app = express();
  app.get('/api/dusk/v1/virtual-book/:market/stream', (req, res) => {
    void openVirtualBookStream(req, res, hub).catch(() =>
      res.status(503).end(),
    );
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const controllers: AbortController[] = [];
  const url = `http://127.0.0.1:${address.port}/api/dusk/v1/virtual-book/${market}/stream?groupingBps=10`;
  async function firstFrame() {
    const controller = new AbortController();
    controllers.push(controller);
    const timeout = setTimeout(() => controller.abort(), 60_000);
    try {
      const res = await fetch(url, { signal: controller.signal });
      assert.equal(res.status, 200);
      const reader = res.body!.getReader(),
        decoder = new TextDecoder();
      let buffered = '';
      for (;;) {
        const result = await reader.read();
        assert.equal(result.done, false, 'Stream closed without a book');
        buffered += decoder.decode(result.value, { stream: true });
        for (;;) {
          const split = buffered.indexOf('\n\n');
          if (split < 0) break;
          const frame = buffered.slice(0, split);
          buffered = buffered.slice(split + 2);
          if (frame.startsWith('event: dusk-virtual-book\ndata: '))
            return JSON.parse(
              frame.slice(frame.indexOf('data: ') + 6),
            ) as VirtualBookEnvelope;
        }
      }
    } finally {
      clearTimeout(timeout);
      controller.abort();
    }
  }
  try {
    const frames = await Promise.all(Array.from({ length: 10 }, firstFrame));
    assert.ok(
      frames.every((frame) => frame.data.revision === frames[0].data.revision),
    );
    assert.ok(
      captures <= 1,
      `Expected at most one shared computation; observed ${captures}`,
    );
    const sample = frames[0],
      { dusk } = await createVirtualBookRuntime();
    const checks = [];
    for (const side of ['bids', 'asks'] as const) {
      const level = sample.data.book[side][5];
      if (!level) continue;
      const inputDecimals =
        side === 'bids' ? sample.data.baseDecimals : sample.data.quoteDecimals;
      const outputDecimals =
        side === 'bids' ? sample.data.quoteDecimals : sample.data.baseDecimals;
      const amount = side === 'bids' ? level.total : level.quoteTotal;
      const input = BigInt(Math.round(amount * 10 ** inputDecimals));
      const mint = new PublicKey(
        side === 'bids'
          ? sample.data.book.quoteMint
          : sample.data.book.baseMint,
      );
      const quote = await dusk.get.previewSwap({
        market,
        exactAssetIn: new BN(input.toString()),
        assetInMint:
          side === 'bids'
            ? sample.data.book.baseMint
            : sample.data.book.quoteMint,
        assetOutMint: mint,
      });
      assert.equal(
        Number(quote.startPriceNad.toString()) / 1e9,
        sample.data.book.mid,
        'Market changed during comparison',
      );
      const rpc = dusk.program.provider.connection,
        info = await rpc.getAccountInfo(mint, 'confirmed');
      assert.ok(info);
      const decoded = await getMint(rpc, mint, 'confirmed', info.owner),
        fees = getTransferFeeConfig(decoded),
        epoch = await rpc.getEpochInfo('confirmed');
      const output = BigInt(quote.amountOut.toString()),
        net =
          output -
          (fees ? calculateEpochFee(fees, BigInt(epoch.epoch), output) : 0n);
      const expected =
        (side === 'bids' ? level.quoteTotal : level.total) *
        10 ** outputDecimals;
      assert.ok(
        Math.abs(Number(net) - expected) <= 2,
        'Streamed output differs from independent native quote',
      );
      checks.push({
        side,
        feePercent: level.feePercent,
        surchargePercent: level.surchargePercent,
        impactPercent: level.impactPercent,
      });
    }
    if (process.env.DUSK_PROBE_OUTPUT)
      writeFileSync(
        process.env.DUSK_PROBE_OUTPUT,
        JSON.stringify(sample, null, 2) + '\n',
      );
    console.log(
      JSON.stringify({
        market,
        clients: frames.length,
        captures,
        revision: sample.data.revision,
        slot: sample.data.sourceSlot,
        checks,
      }),
    );
  } finally {
    controllers.forEach((controller) => controller.abort());
    stopDuskSnapshotStreams();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.end();
  }
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Probe failed');
  process.exitCode = 1;
});
