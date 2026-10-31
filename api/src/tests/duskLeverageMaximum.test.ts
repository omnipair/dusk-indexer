import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { BorshInstructionCoder, BN } from '@coral-xyz/anchor';
import { convertIdlToCamelCase } from '@coral-xyz/anchor/dist/cjs/idl';
import { ComputeBudgetProgram, Connection, PublicKey, SYSVAR_CLOCK_PUBKEY, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { captureLeverageQuoteBank, quoteRpcFetch, runLeverageMaximumProcess } from '../services/duskLeverageMaximum';
import { FrozenLeverageBank, LeverageMaximumInput, parseLeverageMaximumInput, quoteRuntimeBytes, searchFrozenLeverageMaximum, searchFrozenLeverageSize, quoteFrozenLeverageEntry } from '../services/duskLeverageMaximumEngine';
// These historical capacity receipts retain the SBF/IDL they were produced
// under. Current-revision live parity belongs to its own fixture suite.
const legacyProtocol = resolve(__dirname,'../../../protocol/archive/devnet-2026-10-26-cd6f1ec');
process.env.DUSK_PROTOCOL_DIR = legacyProtocol;
const idl = JSON.parse(readFileSync(resolve(legacyProtocol,'idl/dusk.json'),'utf8'));
const pin = JSON.parse(readFileSync(resolve(legacyProtocol,'compatible-deployment.json'),'utf8'));
const fixture = () => JSON.parse(gunzipSync(readFileSync(resolve(__dirname,'../../src/tests/fixtures/leverage-maximum-devnet.json.gz'))).toString()) as {
  input: LeverageMaximumInput; bank: FrozenLeverageBank; expected: { multiplierBps: string; candidates: number };
};
const binary = () => quoteRuntimeBytes(idl.address,pin.binarySha256);
function altered(change: (tx: VersionedTransaction) => void) {
  const { input } = fixture(),tx = VersionedTransaction.deserialize(Buffer.from(input.transaction,'base64'));
  change(tx); return { ...input,transaction: Buffer.from(tx.serialize()).toString('base64') };
}
test('exact pinned SBF searches one coherent concentrated bank without committing any candidate',() => {
  const f = fixture(),hash = createHash('sha256').update(JSON.stringify(f.bank)).digest('hex');
  assert.deepEqual(searchFrozenLeverageMaximum(f.input,f.bank,idl,binary()),f.expected);
  assert.deepEqual(searchFrozenLeverageMaximum(f.input,f.bank,idl,binary()),f.expected);
  assert.equal(hash,createHash('sha256').update(JSON.stringify(f.bank)).digest('hex'));
  assert.equal(f.expected.multiplierBps,'52200'); assert.ok(f.expected.candidates < 13);
});
test('parser binds the full unsigned preview to owner, margin, market, debt side and floor',() => {
  const f = fixture(); assert.equal(parseLeverageMaximumInput(f.input,idl).parsed.entryIndex,2);
  for (const changes of [{ owner: PublicKey.default.toBase58() },{ market: PublicKey.default.toBase58() },{ marginAmount: '100000001' },{ debtAsset: 'base' },{ minimumSourceSlot: -1 },{ transaction: f.input.transaction+'=' }])
    assert.throws(() => parseLeverageMaximumInput({ ...f.input,...changes },idl));
  assert.throws(() => parseLeverageMaximumInput(altered((tx) => { tx.signatures[0][0] = 1; }),idl));
  assert.throws(() => parseLeverageMaximumInput(altered((tx) => { tx.message.compiledInstructions[0].data[1] = 1; }),idl),/budget/);
  assert.throws(() => parseLeverageMaximumInput(altered((tx) => { tx.message.staticAccountKeys[tx.message.compiledInstructions[1].programIdIndex] = SYSVAR_CLOCK_PUBKEY; }),idl),/setup/);
  const coder = new BorshInstructionCoder(convertIdlToCamelCase(idl));
  assert.throws(() => parseLeverageMaximumInput(altered((tx) => {
    const ix = tx.message.compiledInstructions[2],args = (coder.decode(Buffer.from(ix.data))!.data as { args: object }).args;
    ix.data = coder.encode('openLeverage',{ args: { ...args,multiplierBps: new BN(10200) } });
  }),idl),/selection/);
});
test('regressed or mixed clock banks, missing executable bytes and a wrong binary pin fail closed',() => {
  const f = fixture();
  assert.throws(() => searchFrozenLeverageMaximum({ ...f.input,minimumSourceSlot: f.bank.slot+1 },f.bank,idl,binary()),/Regressed/);
  const mixed = fixture(); mixed.bank.slot++;
  assert.throws(() => searchFrozenLeverageMaximum(mixed.input,mixed.bank,idl,binary()),/clock/);
  const missing = fixture(); missing.bank.accounts = missing.bank.accounts.filter((row) => row.account?.owner !== 'BPFLoaderUpgradeab1e11111111111111111111111' || row.account.executable);
  assert.throws(() => searchFrozenLeverageMaximum(missing.input,missing.bank,idl,binary()),/executable/);
  assert.throws(() => quoteRuntimeBytes(idl.address,'0'.repeat(64)),/differs/);
});
test('unrelated transaction failures never become a market-capacity answer',() => {
  const f = fixture(); f.bank.accounts.find((a) => a.address === f.input.owner)!.account!.lamports = 0;
  assert.throws(() => searchFrozenLeverageMaximum(f.input,f.bank,idl,binary()),/execution unavailable/);
});
test('read-only capture keeps the owner unchanged and validates the exact snapshot clock',async () => {
  const f = fixture(),addresses = [new PublicKey(f.input.owner),SYSVAR_CLOCK_PUBKEY]; let calls = 0;
  const rpc = { simulateTransaction: async (tx: VersionedTransaction,config: { accounts: { addresses: string[] } }) => {
    calls++; assert.notEqual(tx.message.staticAccountKeys[0].toBase58(),f.input.owner);
    assert.equal(tx.message.header.numReadonlyUnsignedAccounts,tx.message.staticAccountKeys.length-1);
    return { context: { slot: f.bank.slot },value: { err: null,accounts: config.accounts.addresses.map((key) => {
      const a = f.bank.accounts.find((r) => r.address === key)!.account!;
      return { ...a,data: [a.data,'base64'],rentEpoch: Number(a.rentEpoch) };
    }) } };
  } } as unknown as Connection;
  const bank = await captureLeverageQuoteBank(f.input,addresses,'FJWRK3XJeVD8njSvTFXyHwP2jkatvBqeVwcNAFe5zVfJ',rpc);
  assert.equal(calls,1); assert.deepEqual(bank.accounts[0],f.bank.accounts.find((a) => a.address === f.input.owner));
});
test('payer-owner collision uses a bounded coherent batch retry without simulated fee deductions',async () => {
  const f = fixture(); let calls = 0;
  const rpc = { getMultipleAccountsInfoAndContext: async (keys: PublicKey[]) => ({ context: { slot: ++calls === 1 ? f.bank.slot-1 : f.bank.slot },value: keys.map((key) => {
    const a = f.bank.accounts.find((r) => r.address === key.toBase58())!.account!;
    return { ...a,owner: new PublicKey(a.owner),data: Buffer.from(a.data,'base64'),rentEpoch: Number(a.rentEpoch) };
  }) }) } as unknown as Connection;
  const result = await captureLeverageQuoteBank(f.input,[new PublicKey(f.input.owner)],f.input.owner,rpc);
  assert.equal(calls,2); assert.equal(result.slot,f.bank.slot);
  calls = 0;
  const bad = { getMultipleAccountsInfoAndContext: async (keys: PublicKey[]) => {
    const result = await rpc.getMultipleAccountsInfoAndContext(keys); result.context.slot = f.bank.slot-1; return result;
  } } as unknown as Connection;
  await assert.rejects(captureLeverageQuoteBank(f.input,[new PublicKey(f.input.owner)],f.input.owner,bad),/clock/); assert.equal(calls,3);
});
test('RPC account response memory is bounded before JSON decoding',async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(25*1024*1024)); controller.close(); } }));
    await assert.rejects(quoteRpcFetch('http://unused'),/payload limit/);
  } finally { globalThis.fetch = original; }
});

test('the shipped isolated evaluator returns the native result and observes cancellation',async () => {
  const f = fixture();
  const result = await runLeverageMaximumProcess(f.input,f.bank,idl,idl.address,pin.binarySha256);
  assert.equal(result.kind,'maximum'); assert.equal(result.multiplierBps,f.expected.multiplierBps);
  const controller = new AbortController();
  const pending = runLeverageMaximumProcess(f.input,f.bank,idl,idl.address,pin.binarySha256,controller.signal);
  controller.abort(); await assert.rejects(pending,/cancelled/);
});
test('economic capacity matches the independent protocol runtime with both hLP vaults, concentration, compounding and transfer fees',() => {
  const suite = JSON.parse(gunzipSync(readFileSync(resolve(__dirname,'../../src/tests/fixtures/leverage-maximum-parity.json.gz'))).toString()) as {
    commonAccounts: FrozenLeverageBank['accounts']; fixtures: { name: string; input: LeverageMaximumInput; bank: FrozenLeverageBank; expected: { multiplierBps: string; candidates: number } }[];
  };
  assert.equal(suite.fixtures.length,8);
  for (const f of suite.fixtures) {
    const bank = { ...f.bank,accounts: [...f.bank.accounts,...suite.commonAccounts] };
    assert.deepEqual(searchFrozenLeverageMaximum(f.input,bank,idl,binary()),f.expected,f.name);
  }
});

function sizeInput(input: LeverageMaximumInput, amount: string,kind: 'collateral' | 'notional', multiplierBps = '35000') {
  const tx = VersionedTransaction.deserialize(Buffer.from(input.transaction,'base64'));
  const parsed = parseLeverageMaximumInput(input,idl).parsed,coder = new BorshInstructionCoder(convertIdlToCamelCase(idl));
  tx.message.compiledInstructions[parsed.entryIndex].data = coder.encode('openLeverage',{ args: { ...parsed.args,multiplierBps: new BN(multiplierBps) } });
  return { ...input,transaction: Buffer.from(tx.serialize()).toString('base64'),size: { amount,kind,multiplierBps } };
}
test('fixed leverage size inversion finds the minimum raw margin, accounting for concentrated execution',() => {
  const f = fixture(),input = sizeInput(f.input,'1000000000','collateral');
  const result = searchFrozenLeverageSize(input,f.bank,idl,binary());
  assert.equal(result.multiplierBps,'35000'); assert.equal(result.marginAmount,'76517341');
  assert.equal(result.sizeAmount,'1000000001'); assert.ok(result.candidates < 40);
  const previous = quoteFrozenLeverageEntry(input,f.bank,idl,binary(),'35000',String(BigInt(result.marginAmount)-1n));
  assert.ok(previous.collateral < 1000000000n);
  assert.throws(() => parseLeverageMaximumInput({ ...input,size: { ...input.size,multiplierBps: '35001' } },idl));
  assert.throws(() => parseLeverageMaximumInput({ ...input,size: { ...input.size,amount: '18446744073709551616' } },idl));
});
test('size inversion preserves both debt directions, Token-2022 fees, concentration and both hLP vaults',() => {
  const suite = JSON.parse(gunzipSync(readFileSync(resolve(__dirname,'../../src/tests/fixtures/leverage-maximum-parity.json.gz'))).toString());
  for (const f of suite.fixtures as { name: string; input: LeverageMaximumInput; bank: FrozenLeverageBank }[]) {
    const bank = { ...f.bank,accounts: [...f.bank.accounts,...suite.commonAccounts] };
    for (const kind of ['collateral','notional'] as const) {
      const receipt = quoteFrozenLeverageEntry(f.input,bank,idl,binary(),'35000',f.input.marginAmount);
      const input = sizeInput(f.input,String(receipt[kind]),kind);
      const result = searchFrozenLeverageSize(input,bank,idl,binary());
      assert.equal(result.marginAmount,f.input.marginAmount,`${f.name} ${kind}`);
      assert.equal(result.sizeAmount,String(receipt[kind]));
      assert.equal(result.multiplierBps,'35000');
    }
  }
});
test('unreachable size remains a capacity rejection and never silently reduces leverage',() => {
  const f = fixture(),input = sizeInput(f.input,'100000000000','collateral','50000');
  assert.throws(() => searchFrozenLeverageSize(input,f.bank,idl,binary()),(error: Error) => error.constructor.name === 'NativeLeverageRejection');
});


test('OP-GAMM capacity requests accept one bounded SDK heap frame alongside the CU limit', () => {
  const { input } = fixture();
  const tx = VersionedTransaction.deserialize(Buffer.from(input.transaction,'base64'));
  const original = TransactionMessage.decompile(tx.message);
  const request = (heap: number, duplicate = false) => {
    const instruction = ComputeBudgetProgram.requestHeapFrame({ bytes: heap });
    const message = new TransactionMessage({ payerKey: original.payerKey,recentBlockhash: original.recentBlockhash,
      instructions: [instruction,...(duplicate ? [instruction] : []),...original.instructions] }).compileToV0Message();
    return { ...input,transaction: Buffer.from(new VersionedTransaction(message).serialize()).toString('base64') };
  };
  const candidate = JSON.parse(readFileSync(resolve(__dirname,'../../../protocol/candidates/next-2026-10-31-8fadcc31/idl/dusk.json'),'utf8'));
  assert.equal(parseLeverageMaximumInput(request(256*1024),candidate).parsed.entryIndex,3);
  assert.throws(() => parseLeverageMaximumInput(request(256*1024,true),candidate),/heap budget/);
  assert.throws(() => parseLeverageMaximumInput(request(512*1024),candidate),/heap budget/);
});
