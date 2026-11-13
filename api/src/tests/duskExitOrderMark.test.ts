import test from 'node:test';
import assert from 'node:assert/strict';
import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import type { Dusk, Market } from '@omnipair/dusk-sdk';
import { previewDuskExitOrderMark } from '../services/duskExitOrderMark';
import { marketLayoutVersion } from '../services/duskProtocolSchema';

test('exit marks use the current-slot collateral/debt EMA and validate simulation provenance', async () => {
  const key = new PublicKey(Buffer.alloc(32, 7));
  const expected = { version: marketLayoutVersion(), srlpMint: key, paramsHash: Array(32).fill(4),
    baseSide: { assetMint: key }, quoteSide: { assetMint: key },
    risk: { lastSnapshotSlot: 100, basePriceEmaNad: 2_000_000_000n, quotePriceEmaNad: 500_000_000n } } as unknown as Market;
  let returned = expected;
  const result = { context: { slot: 100 }, value: { err: null as unknown,
    accounts: [{ executable: false, owner: key.toBase58(), data: [Buffer.from('market').toString('base64'), 'base64'] }] } };
  let sends = 0;
  const dusk = { write: { instruction: async () => new TransactionInstruction({ programId: key, keys: [], data: Buffer.alloc(0) }) },
    program: { programId: key, coder: { accounts: { decode: () => returned } }, provider: { connection: {
      simulateTransaction: async () => result, sendTransaction: () => { sends++; },
    } } } } as unknown as Dusk;
  const mark = (side = 1) => previewDuskExitOrderMark(dusk, key, expected, side, key.toBase58(), 100);
  assert.equal((await mark(1))?.priceNad, 2_000_000_000n);
  assert.equal((await mark(0))?.priceNad, 500_000_000n);
  returned = { ...expected, risk: { ...expected.risk, lastSnapshotSlot: 99 } } as unknown as Market;
  await assert.rejects(mark(), /snapshot changed/);
  returned = expected;
  result.context.slot = 99;
  await assert.rejects(mark(), /behind/);
  result.context.slot = 100;
  result.value.accounts[0].executable = true;
  await assert.rejects(mark(), /Invalid exit EMA market/);
  result.value.accounts[0].executable = false;
  result.value.err = { InstructionError: [0, 'Custom'] };
  assert.equal(await mark(), null);
  assert.equal(sends, 0);
});
