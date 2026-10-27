/** Execute the pinned program on a frozen bank; candidate simulations never commit. */
import { BorshInstructionCoder, BN, Idl } from '@coral-xyz/anchor';
import { convertIdlToCamelCase } from '@coral-xyz/anchor/dist/cjs/idl';
import { PublicKey, SYSVAR_CLOCK_PUBKEY, VersionedTransaction } from '@solana/web3.js';
import { Clock, ComputeBudget, FailedTransactionMetadata, FeatureSet, LiteSVM } from 'litesvm';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

export interface FrozenQuoteAccount {
  address: string;
  account: { data: string; owner: string; executable: boolean; lamports: number; rentEpoch: string } | null;
}
export interface FrozenLeverageBank { slot: number; accounts: FrozenQuoteAccount[] }
export interface LeverageMaximumInput {
  schemaVersion: 'dusk-leverage-maximum-request.v1';
  transaction: string; owner: string; market: string;
  debtAsset: 'base' | 'quote'; marginAmount: string;
  minimumSourceSlot: number; deploymentIdentitySha256: string;
}
export interface ParsedLeverageMaximum {
  transaction: VersionedTransaction; entryIndex: number;
  args: Record<string, unknown>; maximumGrid: number;
}
const CAPACITY = new Set(['BorrowExceedsReserve','InsufficientLiquidity','InsufficientCashReserve0','InsufficientCashReserve1',
  'InsufficientBorrowHeadroom','InsufficientMarketHealth','DailyLimitExceeded','LeverageMultiplierTooHigh','LeverageInitialMarginTooLow']);
export class NativeLeverageRejection extends Error {
  constructor(readonly rejection: string) { super(rejection); }
}
const BPF_LOADER = 'BPFLoader2111111111111111111111111111111111';
const UPGRADEABLE = 'BPFLoaderUpgradeab1e11111111111111111111111';
const BUILTINS = new Set(['11111111111111111111111111111111','ComputeBudget111111111111111111111111111111']);
const SETUP_PROGRAMS = new Set([...BUILTINS,'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA','TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb','ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL']);

export function parseLeverageMaximumInput(value: unknown, idl: Idl): { input: LeverageMaximumInput; parsed: ParsedLeverageMaximum } {
  const v = value as Partial<LeverageMaximumInput> | null;
  if (!v || v.schemaVersion !== 'dusk-leverage-maximum-request.v1' || typeof v.transaction !== 'string' || v.transaction.length > 16384
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(v.transaction) || !Number.isSafeInteger(v.minimumSourceSlot) || v.minimumSourceSlot! < 0
    || !/^[a-f0-9]{64}$/.test(v.deploymentIdentitySha256 ?? '') || !/^[1-9][0-9]{0,19}$/.test(v.marginAmount ?? '')
    || BigInt(v.marginAmount!) > (1n<<64n)-1n || !['base','quote'].includes(v.debtAsset ?? '')) throw new Error('Invalid leverage maximum input');
  for (const key of [v.owner,v.market]) if (typeof key !== 'string' || new PublicKey(key).toBase58() !== key) throw new Error('Invalid leverage maximum identity');
  const bytes = Buffer.from(v.transaction,'base64');
  if (bytes.toString('base64') !== v.transaction) throw new Error('Invalid preview message encoding');
  const transaction = VersionedTransaction.deserialize(bytes), message = transaction.message;
  if (message.version !== 0 || message.addressTableLookups.length || message.staticAccountKeys.length > 90
    || transaction.signatures.some((signature) => signature.some((byte) => byte !== 0))
    || message.header.numRequiredSignatures !== 1 || message.staticAccountKeys[0].toBase58() !== v.owner
    || message.compiledInstructions.length > 12) throw new Error('Expected a bounded unsigned preview');
  const clientIdl = convertIdlToCamelCase(idl);
  const coder = new BorshInstructionCoder(clientIdl), programId = idl.address;
  let budgets = 0;
  const entries = message.compiledInstructions.flatMap((ix,index) => {
    const target = message.staticAccountKeys[ix.programIdIndex]?.toBase58();
    if (!target || ix.accountKeyIndexes.some((key) => key >= message.staticAccountKeys.length)) throw new Error('Invalid preview account index');
    if (target !== programId) {
      if (!SETUP_PROGRAMS.has(target)) throw new Error('Unexpected preview setup program');
      if (target === 'ComputeBudget111111111111111111111111111111') {
        const data = Buffer.from(ix.data);
        if (++budgets !== 1 || data.length !== 5 || data[0] !== 2 || ![800000,1400000].includes(data.readUInt32LE(1))) throw new Error('Invalid preview compute budget');
      }
      return [];
    }
    const decoded = coder.decode(Buffer.from(ix.data));
    if (decoded?.name !== 'openLeverage') throw new Error('Unexpected Dusk preview instruction');
    return [{ index, args: (decoded.data as { args: Record<string,unknown> }).args, ix }];
  });
  if (entries.length !== 1 || budgets !== 1) throw new Error('Expected one leverage open and compute budget');
  const entry = entries[0], args = entry.args;
  const instruction = clientIdl.instructions.find((ix) => ix.name === 'openLeverage')!;
  const named = (name: string) => {
    const index = instruction.accounts.findIndex((account) => account.name === name);
    if (index < 0) throw new Error('Missing leverage preview account');
    const key = message.staticAccountKeys[entry.ix.accountKeyIndexes[index]];
    if (!key) throw new Error('Missing leverage preview account');
    return key.toBase58();
  };
  if (String(args.marginAmount) !== v.marginAmount || String(args.multiplierBps) !== '10100' || Number(args.debtAsset) !== (v.debtAsset === 'base' ? 0 : 1)
    || args.referrer !== null || args.positionOwner !== null || String(args.minCollateralOut) !== '0' || String(args.limitPriceNad) !== '0'
    || named('market') !== v.market || named('owner') !== v.owner || named('payer') !== v.owner) throw new Error('Leverage preview selection mismatch');
  const rawMaximum = idl.constants?.find((constant) => constant.name === 'LEVERAGE_MAX_MULTIPLIER_BPS')?.value;
  if (!rawMaximum || !/^\d+$/.test(rawMaximum)) throw new Error('Missing native leverage limit');
  const maximumGrid = Number(rawMaximum)/100;
  if (!Number.isSafeInteger(maximumGrid) || maximumGrid < 101 || maximumGrid > 10000) throw new Error('Invalid native leverage limit');
  return { input: v as LeverageMaximumInput, parsed: { transaction,entryIndex: entry.index,args,maximumGrid } };
}

export function quoteRuntimeBytes(programId: string, binarySha256: string, directory = resolve(process.env.DUSK_PROTOCOL_DIR?.trim() || resolve(__dirname,'../../../protocol'),'quote-runtime')) {
  const manifest = JSON.parse(readFileSync(resolve(directory,'manifest.json'),'utf8')) as { schemaVersion: string; programId: string; programBinarySha256: string; payloadSha256: string; payloadBytes: number; allocatedBinaryBytes: number };
  const bytes = readFileSync(resolve(directory,'dusk.so'));
  const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex');
  if (manifest.schemaVersion !== 'dusk-quote-runtime.v1' || manifest.programId !== programId || manifest.programBinarySha256 !== binarySha256
    || bytes.length !== manifest.payloadBytes || !Number.isSafeInteger(manifest.allocatedBinaryBytes) || manifest.allocatedBinaryBytes < bytes.length
    || manifest.allocatedBinaryBytes > 8*1024*1024 || hash(bytes) !== manifest.payloadSha256
    || hash(Buffer.concat([bytes,Buffer.alloc(manifest.allocatedBinaryBytes-bytes.length)])) !== binarySha256) throw new Error('Native quote runtime differs from deployment');
  return bytes;
}

/** Every predicate uses the complete original transaction and exactly the same bank. */
export function searchFrozenLeverageMaximum(input: LeverageMaximumInput, bank: FrozenLeverageBank, idl: Idl, binary: Uint8Array) {
  const { parsed } = parseLeverageMaximumInput(input,idl), programId = new PublicKey(idl.address);
  if (!Number.isSafeInteger(bank.slot) || bank.slot < input.minimumSourceSlot) throw new Error('Regressed native quote bank');
  const clockAccount = bank.accounts.find((row) => row.address === SYSVAR_CLOCK_PUBKEY.toBase58())?.account;
  if (!clockAccount || clockAccount.owner !== 'Sysvar1111111111111111111111111111111111111') throw new Error('Missing native quote clock');
  const clock = Buffer.from(clockAccount.data,'base64');
  if (clock.length !== 40 || clock.readBigUInt64LE(0) !== BigInt(bank.slot)) throw new Error('Quote clock is not from its bank');
  const svm = new LiteSVM(),features = new FeatureSet();
  // Match the protocol's strict native test runtime, retaining its default
  // feature snapshot instead of enabling unrelated future features.
  for (const id of features.getInactiveFeatures()) {
    const a = svm.getAccount(new PublicKey(id));
    if (a?.owner.toBase58() === 'Feature111111111111111111111111111111111111' && a.data.length === 9 && a.data[0] === 1) features.activate(id,Buffer.from(a.data).readBigUInt64LE(1));
  }
  features.activate(new PublicKey('Eoh7e1sDqtyPtuiWAhBNSJinvtJWTTDgeUMRi3RF8zWS').toBytes(),0n);
  // This is an economic-capacity candidate, not a Solana execution receipt.
  // Native-runtime CU estimation differs across environments. Give this local
  // search a bounded larger budget; the client MUST execute the selected full
  // transaction against RPC at its real 1.4M ceiling before displaying a quote.
  const budget = new ComputeBudget(); budget.computeUnitLimit = 5000000n;
  svm.withFeatureSet(features).withComputeBudget(budget).withBuiltins().withDefaultPrograms().withPrecompiles().withSigverify(false).withBlockhashCheck(false).withTransactionHistory(0n);
  svm.warpToSlot(BigInt(bank.slot));
  svm.setClock(new Clock(clock.readBigUInt64LE(0),clock.readBigInt64LE(8),clock.readBigUInt64LE(16),clock.readBigUInt64LE(24),clock.readBigInt64LE(32)));
  svm.addProgram(programId,binary);
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
    const existing = svm.getAccount(new PublicKey(row.address));
    let existingBytes = existing ? Buffer.from(existing.data) : Buffer.alloc(0);
    if (existing?.owner.toBase58() === UPGRADEABLE && existingBytes.length === 36 && existingBytes.readUInt32LE(0) === 2) {
      const data = svm.getAccount(new PublicKey(existingBytes.subarray(4)));
      existingBytes = data ? Buffer.from(data.data).subarray(45) : Buffer.alloc(0);
    }
    if (!existingBytes.equals(bytes)) svm.addProgramWithLoader(new PublicKey(row.address),bytes,new PublicKey(account.owner));
  }
  for (const row of bank.accounts) {
    const a = row.account;
    if (!a || a.executable || row.address === SYSVAR_CLOCK_PUBKEY.toBase58()) continue;
    if (!Number.isSafeInteger(a.lamports) || a.lamports < 0 || !/^(0|[1-9]\d*)$/.test(a.rentEpoch) || BigInt(a.rentEpoch) > (1n<<64n)-1n) throw new Error('Invalid native quote balance');
    svm.setAccount(new PublicKey(row.address),{ ...a,owner: new PublicKey(a.owner),data: Buffer.from(a.data,'base64'),rentEpoch: BigInt(a.rentEpoch) as unknown as number });
  }
  const coder = new BorshInstructionCoder(convertIdlToCamelCase(idl)), capacities = new Map(idl.errors?.filter((e) => CAPACITY.has(e.name)).map((e) => [e.code,e.name]));
  let candidates = 0;
  const read = (grid: number) => {
    const transaction = VersionedTransaction.deserialize(Buffer.from(input.transaction,'base64'));
    transaction.message.compiledInstructions[parsed.entryIndex].data = coder.encode('openLeverage',{ args: { ...parsed.args,multiplierBps: new BN(grid*100) } });
    candidates++;
    const result = svm.simulateTransaction(transaction);
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
