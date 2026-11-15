import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { Idl } from '@coral-xyz/anchor';
import { convertIdlToCamelCase } from '@coral-xyz/anchor/dist/cjs/idl';
import { PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { address } from '@solana/kit';
import { quoteFrozenVirtualBook } from '../services/duskFrozenVirtualBookEngine';
import { runFrozenVirtualBookProcess } from '../services/duskFrozenVirtualBook';
import { createFrozenProgramRuntime } from '../services/duskFrozenProgramRuntime';
import { frozenPreviewConnection } from '../services/duskFrozenPreviewConnection';
import { quoteRuntimeBytes, FrozenLeverageBank } from '../services/duskLeverageMaximumInput';
import type { DuskDeploymentEnvelope } from '../services/duskDeploymentService';
import type { VirtualBookSelection } from '../services/duskVirtualBook';

const protocol = resolve(__dirname, '../../../protocol');
process.env.DUSK_PROTOCOL_DIR = protocol;
const idl = JSON.parse(readFileSync(resolve(protocol, 'idl/dusk.json'), 'utf8')) as Idl;
const fixture = () => JSON.parse(gunzipSync(readFileSync(resolve(__dirname, '../../src/tests/fixtures/virtual-book-mainnet-bank.json.gz'))).toString()) as {
  bank: FrozenLeverageBank; deployment: DuskDeploymentEnvelope; selection: VirtualBookSelection;
};

test('the deployed SBF prices all 12/24/36 levels from one unchanged mainnet bank', async () => {
  const f = fixture(), original = JSON.stringify(f.bank);
  const frames: Awaited<ReturnType<typeof quoteFrozenVirtualBook>>[] = [];
  for (const levels of [12, 24, 36]) {
    const result = await quoteFrozenVirtualBook(f.bank, { ...f.selection, levels }, f.deployment);
    assert.equal(result.slot, f.bank.slot);
    assert.equal(result.firstQuoteSlot, f.bank.slot);
    assert.equal(result.book.slot, f.bank.slot);
    assert.equal(result.book.bids.length, levels);
    assert.equal(result.book.asks.length, levels);
    assert.equal(result.book.mid, 0.04062938);
    assert.ok(result.book.bids[0].price < result.book.mid);
    assert.ok(result.book.asks[0].price > result.book.mid);
    for (const side of ['bids', 'asks'] as const) {
      assert.ok(result.book[side].every(row => row.size > 0 && row.quoteSize > 0 && Number.isFinite(row.price)));
      if (frames.length) assert.deepEqual(result.book[side].slice(0, 12), frames[0].book[side]);
    }
    frames.push(result);
  }
  assert.equal(JSON.stringify(f.bank), original, 'simulated updates never commit to the captured bank');
  assert.deepEqual(await quoteFrozenVirtualBook(f.bank, f.selection, f.deployment), frames[0]);
});

test('missing accounts, a mixed Clock or a different deployed binary invalidate native depth', async () => {
  const f = fixture();
  await assert.rejects(quoteFrozenVirtualBook({ ...f.bank, slot: f.bank.slot + 1 }, f.selection, f.deployment), /clock/i);
  await assert.rejects(quoteFrozenVirtualBook(f.bank, f.selection, { ...f.deployment, sourceSlot: f.bank.slot + 1 }), /deployment differs/);
  await assert.rejects(quoteFrozenVirtualBook(f.bank, f.selection, { ...f.deployment, programBinarySha256: '0'.repeat(64) }), /runtime differs/);
  const missing = fixture();
  missing.bank.accounts = missing.bank.accounts.filter(row => row.address !== missing.selection.market);
  await assert.rejects(quoteFrozenVirtualBook(missing.bank, missing.selection, missing.deployment));
});

test('the frozen SDK transport has no send/sign path and rejects writes or newer read floors', async () => {
  const f = fixture(), bytes = quoteRuntimeBytes(f.deployment.programId, f.deployment.programBinarySha256);
  const svm = createFrozenProgramRuntime(f.bank, f.deployment.programId, bytes);
  const tags = convertIdlToCamelCase(idl).instructions.filter(ix => ['previewMarket', 'previewSwap'].includes(ix.name)).map(ix => Uint8Array.from(ix.discriminator));
  const rpc = frozenPreviewConnection(svm, f.bank, f.deployment.programId, tags);
  assert.equal(rpc.sendTransaction, undefined);
  assert.equal(rpc.sendRawTransaction, undefined);
  const key = new PublicKey(f.selection.market);
  const account = svm.getAccount(address(f.selection.market));
  assert.ok(account.exists);
  const before = Buffer.from(account.data);
  assert.equal((await rpc.getAccountInfoAndContext(key, { minContextSlot: f.bank.slot })).context.slot, f.bank.slot);
  await assert.rejects(rpc.getAccountInfoAndContext(key, { minContextSlot: f.bank.slot + 1 }), /read floor/);
  const tx = new VersionedTransaction(new TransactionMessage({
    payerKey: new PublicKey(f.bank.accounts.find(row => row.account?.data === '')!.address),
    recentBlockhash: PublicKey.default.toBase58(),
    instructions: [SystemProgram.transfer({ fromPubkey: key, toPubkey: PublicKey.default, lamports: 1 })],
  }).compileToV0Message());
  await assert.rejects(rpc.simulateTransaction(tx, {}), /only accepts approved read-only/);
  await assert.rejects(rpc.simulateTransaction(tx, { minContextSlot: f.bank.slot + 1 }), /read floor/);
  tx.message.staticAccountKeys[tx.message.compiledInstructions[0].programIdIndex] = new PublicKey(f.deployment.programId);
  await assert.rejects(rpc.simulateTransaction(tx, {}), /only accepts approved read-only/);
  const after = svm.getAccount(address(f.selection.market));
  assert.ok(after.exists);
  assert.deepEqual(Buffer.from(after.data), before);
});

test('the shipped isolated book worker returns coherent depth and terminates on cancellation', async () => {
  const f = fixture();
  const result = await runFrozenVirtualBookProcess(f.bank, { ...f.selection, levels: 36 }, f.deployment);
  assert.equal(result.slot, f.bank.slot);
  assert.equal(result.book.bids.length, 36);
  const controller = new AbortController();
  const pending = runFrozenVirtualBookProcess(f.bank, f.selection, f.deployment, controller.signal);
  controller.abort();
  await assert.rejects(pending, /cancelled/);
  await assert.rejects(runFrozenVirtualBookProcess(f.bank, f.selection, { ...f.deployment, programBinarySha256: '0'.repeat(64) }), /unavailable/);
  // A rejected or cancelled request cannot poison the next worker.
  assert.equal((await runFrozenVirtualBookProcess(f.bank,f.selection,f.deployment)).slot,f.bank.slot);
});

test('a reused process always quotes a new VM with the requested Clock and accounts',async () => {
  const f = fixture(),first = await runFrozenVirtualBookProcess(f.bank,f.selection,f.deployment);
  const next = fixture();
  next.bank.slot += 5;
  const clockRow = next.bank.accounts.find(row => row.address === 'SysvarC1ock11111111111111111111111111111111')!;
  const clock = Buffer.from(clockRow.account!.data,'base64');
  clock.writeBigUInt64LE(BigInt(next.bank.slot),0);
  clockRow.account!.data = clock.toString('base64');
  const second = await runFrozenVirtualBookProcess(next.bank,{ ...next.selection,levels: 24 },next.deployment);
  assert.equal(second.slot,next.bank.slot);
  assert.equal(second.firstQuoteSlot,next.bank.slot);
  assert.equal(second.book.slot,next.bank.slot);
  assert.equal(second.book.bids.length,24);
  const third = await runFrozenVirtualBookProcess(f.bank,f.selection,f.deployment);
  assert.deepEqual(third.book,first.book,'the intervening bank never mutates the original bank');
  assert.equal(third.slot,first.slot);
});
