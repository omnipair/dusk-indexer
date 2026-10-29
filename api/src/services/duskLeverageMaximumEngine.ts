/** Execute the pinned program on a frozen bank; candidate simulations never commit. */
import { NATIVE_MINT, NATIVE_MINT_2022 } from '@solana/spl-token';
import { BorshAccountsCoder, BorshInstructionCoder, BN, Idl } from '@coral-xyz/anchor';
import { convertIdlToCamelCase } from '@coral-xyz/anchor/dist/cjs/idl';
import { PublicKey, SYSVAR_CLOCK_PUBKEY, SYSVAR_RENT_PUBKEY, VersionedTransaction } from '@solana/web3.js';
import { address, getTransactionDecoder, lamports } from '@solana/kit';
import { Clock, ComputeBudget, FailedTransactionMetadata, FeatureSet, Rent, LiteSVM } from 'litesvm';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

export { FrozenQuoteAccount, FrozenLeverageBank, LeverageMaximumInput, parseLeverageMaximumInput, quoteRuntimeBytes } from './duskLeverageMaximumInput';
import { FrozenLeverageBank, LeverageMaximumInput, parseLeverageMaximumInput } from './duskLeverageMaximumInput';
const CAPACITY = new Set(['BorrowExceedsReserve','InsufficientLiquidity','InsufficientCashReserve0','InsufficientCashReserve1',
  'InsufficientBorrowHeadroom','InsufficientMarketHealth','DailyLimitExceeded','LeverageMultiplierTooHigh','LeverageInitialMarginTooLow']);
export class NativeLeverageRejection extends Error {
  constructor(readonly rejection: string) { super(rejection); }
}
const BPF_LOADER = 'BPFLoader2111111111111111111111111111111111';
const UPGRADEABLE = 'BPFLoaderUpgradeab1e11111111111111111111111';
const BUILTINS = new Set(['11111111111111111111111111111111','ComputeBudget111111111111111111111111111111']);

function quoteFeatureSet() {
  const directory = resolve(process.env.DUSK_PROTOCOL_DIR?.trim() || resolve(__dirname,'../../../protocol'),'quote-runtime');
  const manifest = JSON.parse(readFileSync(resolve(directory,'manifest.json'),'utf8')) as { featureSetSha256: string };
  const bytes = readFileSync(resolve(directory,'feature-set.json'));
  if (createHash('sha256').update(bytes).digest('hex') !== manifest.featureSetSha256) throw new Error('Native quote feature set differs');
  const pin = JSON.parse(bytes.toString()) as { schemaVersion: string; features: { address: string; slot: string }[] };
  if (pin.schemaVersion !== 'dusk-quote-features.v1' || pin.features.length !== 220) throw new Error('Invalid native quote feature set');
  const features = new FeatureSet();
  for (const feature of pin.features) features.activate(new PublicKey(feature.address).toBytes(),BigInt(feature.slot));
  return features;
}

/** Every predicate uses the complete original transaction and exactly the same bank. */
function frozenLeverageEvaluator(input: LeverageMaximumInput, bank: FrozenLeverageBank, idl: Idl, binary: Uint8Array) {
  const { parsed } = parseLeverageMaximumInput(input,idl), programId = new PublicKey(idl.address);
  if (!Number.isSafeInteger(bank.slot) || bank.slot < input.minimumSourceSlot) throw new Error('Regressed native quote bank');
  const clockAccount = bank.accounts.find((row) => row.address === SYSVAR_CLOCK_PUBKEY.toBase58())?.account;
  if (!clockAccount || clockAccount.owner !== 'Sysvar1111111111111111111111111111111111111') throw new Error('Missing native quote clock');
  const clock = Buffer.from(clockAccount.data,'base64');
  if (clock.length !== 40 || clock.readBigUInt64LE(0) !== BigInt(bank.slot)) throw new Error('Quote clock is not from its bank');
  const svm = new LiteSVM(),features = quoteFeatureSet();
  // This is an economic-capacity candidate, not a Solana execution receipt.
  // Native-runtime CU estimation differs across environments. Give this local
  // search a bounded larger budget; the client MUST execute the selected full
  // transaction against RPC at its real 1.4M ceiling before displaying a quote.
  const budget = new ComputeBudget(); budget.computeUnitLimit = 5000000n;
  svm.withFeatureSet(features).withComputeBudget(budget).withBuiltins().withDefaultPrograms().withPrecompiles().withSigverify(false).withBlockhashCheck(false).withTransactionHistory(0n);
  svm.warpToSlot(BigInt(bank.slot));
  svm.setClock(new Clock(clock.readBigUInt64LE(0),clock.readBigInt64LE(8),clock.readBigUInt64LE(16),clock.readBigUInt64LE(24),clock.readBigInt64LE(32)));
  const rentAccount = bank.accounts.find((row) => row.address === SYSVAR_RENT_PUBKEY.toBase58())?.account;
  const rent = rentAccount && Buffer.from(rentAccount.data,'base64');
  if (!rent || rent.length !== 17 || rentAccount!.owner !== 'Sysvar1111111111111111111111111111111111111') throw new Error('Missing quote rent');
  svm.setRent(new Rent(rent.readBigUInt64LE(0),rent.readDoubleLE(8),rent[16]));
  svm.addProgram(address(programId.toBase58()),binary);
  // Load actual executable bytes for token/hook CPIs rather than approximating them.
  for (const row of bank.accounts) {
    const account = row.account;
    if (!account?.executable || row.address === idl.address || BUILTINS.has(row.address)) continue;
    let bytes = Buffer.from(account.data,'base64');
    if (account.owner === UPGRADEABLE) {
      if (bytes.length !== 36 || bytes.readUInt32LE(0) !== 2) throw new Error('Invalid quote program account');
      const dataKey = new PublicKey(bytes.subarray(4)).toBase58(), data = bank.accounts.find((a) => a.address === dataKey)?.account;
      if (!data || data.owner !== UPGRADEABLE) throw new Error('Missing quote CPI executable');
      bytes = Buffer.from(data.data,'base64');
      if (bytes.length <= 45 || bytes.readUInt32LE(0) !== 3 || bytes.readBigUInt64LE(4) > BigInt(bank.slot)) throw new Error('Invalid quote CPI deployment');
      bytes = bytes.subarray(45);
    } else if (account.owner !== BPF_LOADER) throw new Error('Unsupported native quote executable');
    if (!bytes.subarray(0,4).equals(Buffer.from([127,69,76,70]))) throw new Error('Invalid quote executable');
    // Preserve the runtime's already-loaded program when its executable bytes
    // exactly match the captured CPI. Re-registering identical default programs
    // needlessly changes their program-cache execution environment.
    const existing = svm.getAccount(address(row.address));
    let existingBytes = existing.exists ? Buffer.from(existing.data) : Buffer.alloc(0);
    if (existing.exists && existing.programAddress === UPGRADEABLE && existingBytes.length === 36 && existingBytes.readUInt32LE(0) === 2) {
      const data = svm.getAccount(address(new PublicKey(existingBytes.subarray(4)).toBase58()));
      existingBytes = data.exists ? Buffer.from(data.data).subarray(45) : Buffer.alloc(0);
    }
    if (!existingBytes.equals(bytes)) svm.addProgramWithLoader(address(row.address),bytes,address(account.owner));
  }
  for (const row of bank.accounts) {
    const a = row.account;
    if (!a || a.executable || row.address === SYSVAR_CLOCK_PUBKEY.toBase58()) continue;
    if (!Number.isSafeInteger(a.lamports) || a.lamports < 0 || !/^(0|[1-9]\d*)$/.test(a.rentEpoch) || BigInt(a.rentEpoch) > (1n<<64n)-1n) throw new Error('Invalid native quote balance');
    svm.setAccount({ address: address(row.address),programAddress: address(a.owner),lamports: lamports(BigInt(a.lamports)),data: Buffer.from(a.data,'base64'),executable: a.executable,space: BigInt(Buffer.from(a.data,'base64').length) });
  }
  const coder = new BorshInstructionCoder(convertIdlToCamelCase(idl)), capacities = new Map(idl.errors?.filter((e) => CAPACITY.has(e.name)).map((e) => [e.code,e.name]));
  let candidates = 0;
  const instruction = convertIdlToCamelCase(idl).instructions.find((ix) => ix.name === 'openLeverage')!;
  const accountIndex = (name: string) => parsed.transaction.message.compiledInstructions[parsed.entryIndex].accountKeyIndexes[instruction.accounts.findIndex((a) => a.name === name)];
  const positionKey = parsed.transaction.message.staticAccountKeys[accountIndex('leveragePosition')].toBase58();
  const accountsCoder = new BorshAccountsCoder(convertIdlToCamelCase(idl));
  const read = (multiplierBps: string,marginAmount = input.marginAmount) => {
    const transaction = VersionedTransaction.deserialize(Buffer.from(input.transaction,'base64'));
    let entryIndex = parsed.entryIndex;
    transaction.message.compiledInstructions[entryIndex].data = coder.encode('openLeverage',{ args: { ...parsed.args,marginAmount: new BN(marginAmount),multiplierBps: new BN(multiplierBps) } });
    // Native SOL uses an ephemeral wrapped account. Resize its funding too;
    // the final client rebuilds the SDK plan for the chosen amount from scratch.
    const mint = transaction.message.staticAccountKeys[accountIndex('debtMint')].toBase58();
    if (input.size && [NATIVE_MINT.toBase58(),NATIVE_MINT_2022.toBase58()].includes(mint)) {
      const destination = accountIndex('ownerDebtAccount'), owner = transaction.message.staticAccountKeys.findIndex((key) => key.toBase58() === input.owner);
      const system = transaction.message.staticAccountKeys.findIndex((key) => key.toBase58() === '11111111111111111111111111111111');
      const token = accountIndex(mint === 'So11111111111111111111111111111111111111112' ? 'tokenProgram' : 'token2022Program');
      let wrappedSource: number | undefined;
      const keep = transaction.message.compiledInstructions.filter((ix,index) => {
        if (index >= parsed.entryIndex) return true;
        if (ix.programIdIndex === system && Buffer.from(ix.data).length === 12 && Buffer.from(ix.data).readUInt32LE(0) === 2 && ix.accountKeyIndexes[1] === destination) return false;
        if (ix.programIdIndex === token && ix.data[0] === 3 && ix.accountKeyIndexes[1] === destination) { wrappedSource = ix.accountKeyIndexes[0]; return false; }
        return !(ix.programIdIndex === token && ix.data[0] === 17 && ix.accountKeyIndexes[0] === destination);
      });
      const source = wrappedSource === undefined ? undefined : bank.accounts.find((row) => row.address === transaction.message.staticAccountKeys[wrappedSource!].toBase58())?.account;
      const available = source ? Buffer.from(source.data,'base64').readBigUInt64LE(64) : 0n;
      const amount = BigInt(marginAmount),wrapped = available < amount ? available : amount, funding = [];
      if (wrapped > 0n) { const data = Buffer.alloc(9); data[0] = 3; data.writeBigUInt64LE(wrapped,1); funding.push({ programIdIndex: token,accountKeyIndexes: [wrappedSource!,destination,owner],data }); }
      if (amount > wrapped) { const data = Buffer.alloc(12); data.writeUInt32LE(2); data.writeBigUInt64LE(amount-wrapped,4); funding.push({ programIdIndex: system,accountKeyIndexes: [owner,destination],data },{ programIdIndex: token,accountKeyIndexes: [destination],data: Buffer.from([17]) }); }
      entryIndex = keep.findIndex((ix) => ix.programIdIndex === parsed.transaction.message.compiledInstructions[parsed.entryIndex].programIdIndex);
      keep.splice(entryIndex,0,...funding); entryIndex += funding.length;
      transaction.message.compiledInstructions.splice(0,transaction.message.compiledInstructions.length,...keep);
    }
    candidates++;
    const result = svm.simulateTransaction(getTransactionDecoder().decode(transaction.serialize()));
    if (!(result instanceof FailedTransactionMetadata)) {
      const position = result.postAccounts().find((a) => a.address === positionKey);
      if (!position || position.programAddress !== idl.address) throw new Error('Missing native size receipt');
      const state = accountsCoder.decode('leveragePosition',Buffer.from(position.data));
      return { collateral: BigInt(state.collateralAmount.toString()),notional: BigInt(state.openNotional.toString()) };
    }
    const error = result.err() as unknown as { index?: number; err?: () => { code?: number } };
    const code = typeof error.err === 'function' ? error.err()?.code : undefined;
    const rejection = error.index === entryIndex && code !== undefined ? capacities.get(code) : undefined;
    if (rejection) throw new NativeLeverageRejection(rejection);
    throw Object.assign(new Error('Native quote execution unavailable'),{ cause: result.err().toString(),logs: result.meta().logs() });
  };
  return { read,parsed,count: () => candidates };
}

/** Native entry receipt for deterministic quote parity checks. Never commits. */
export function quoteFrozenLeverageEntry(input: LeverageMaximumInput, bank: FrozenLeverageBank, idl: Idl, binary: Uint8Array, multiplierBps: string, marginAmount: string) {
  return frozenLeverageEvaluator(input,bank,idl,binary).read(multiplierBps,marginAmount);
}

export function searchFrozenLeverageMaximum(input: LeverageMaximumInput, bank: FrozenLeverageBank, idl: Idl, binary: Uint8Array) {
  const evaluator = frozenLeverageEvaluator(input,bank,idl,binary);
  let low = 101,high = evaluator.parsed.maximumGrid;
  evaluator.read(String(low*100));
  while (low < high) {
    const middle = Math.ceil((low+high)/2);
    try { evaluator.read(String(middle*100)); low = middle; }
    catch (error) { if (!(error instanceof NativeLeverageRejection)) throw error; high = middle-1; }
  }
  return { multiplierBps: String(low*100),candidates: evaluator.count() };
}

/** Minimum raw margin whose native receipt reaches the requested size. */
export function searchFrozenLeverageSize(input: LeverageMaximumInput, bank: FrozenLeverageBank, idl: Idl, binary: Uint8Array) {
  if (!input.size) throw new Error('Missing fixed-leverage size');
  const { amount,kind,multiplierBps } = input.size,target = BigInt(amount);
  const evaluator = frozenLeverageEvaluator(input,bank,idl,binary);
  const max = (1n<<64n)-1n;
  let low = 0n,high = BigInt(input.marginAmount),lastRejection: NativeLeverageRejection | undefined;
  const read = (margin: bigint) => {
    try { return evaluator.read(multiplierBps,String(margin))[kind]; }
    catch (error) { if (!(error instanceof NativeLeverageRejection)) throw error; lastRejection = error; return null; }
  };
  let value = read(high);
  // Bracket using native outcomes, never an assumed spot-price conversion.
  while (value !== null && value < target && high < max) {
    low = high; high = high > max/2n ? max : high*2n; value = read(high);
  }
  if (value !== null && value < target) throw new NativeLeverageRejection('InsufficientLiquidity');
  while (high-low > 1n) {
    const middle = (low+high)/2n,result = read(middle);
    if (result === null || result >= target) high = middle;
    else low = middle;
  }
  value = read(high);
  if (value === null) throw lastRejection ?? new Error('Native size unavailable');
  if (value < target) throw new Error('Native size search did not converge');
  return { marginAmount: String(high),sizeAmount: String(value),multiplierBps,candidates: evaluator.count() };
}
