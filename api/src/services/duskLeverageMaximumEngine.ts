/** Execute the pinned program on a frozen bank; candidate simulations never commit. */
import { BorshInstructionCoder, BN, Idl } from '@coral-xyz/anchor';
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
export function searchFrozenLeverageMaximum(input: LeverageMaximumInput, bank: FrozenLeverageBank, idl: Idl, binary: Uint8Array) {
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
  const read = (grid: number) => {
    const transaction = VersionedTransaction.deserialize(Buffer.from(input.transaction,'base64'));
    transaction.message.compiledInstructions[parsed.entryIndex].data = coder.encode('openLeverage',{ args: { ...parsed.args,multiplierBps: new BN(grid*100) } });
    candidates++;
    const result = svm.simulateTransaction(getTransactionDecoder().decode(transaction.serialize()));
    if (!(result instanceof FailedTransactionMetadata)) return true;
    const error = result.err() as unknown as { index?: number; err?: () => { code?: number } };
    const code = typeof error.err === 'function' ? error.err()?.code : undefined;
    const rejection = error.index === parsed.entryIndex && code !== undefined ? capacities.get(code) : undefined;
    if (rejection) throw new NativeLeverageRejection(rejection);
    throw Object.assign(new Error('Native quote execution unavailable'),{ cause: result.err().toString(),logs: result.meta().logs() });
  };
  let low = 101,high = parsed.maximumGrid;
  read(low);
  while (low < high) {
    const middle = Math.ceil((low+high)/2);
    try { read(middle); low = middle; }
    catch (error) { if (!(error instanceof NativeLeverageRejection)) throw error; high = middle-1; }
  }
  return { multiplierBps: String(low*100),candidates };
}
