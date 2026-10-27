/** Pure request/runtime identity validation: no native VM is loaded by the API process. */
import { BorshInstructionCoder, Idl } from '@coral-xyz/anchor';
import { convertIdlToCamelCase } from '@coral-xyz/anchor/dist/cjs/idl';
import { PublicKey, VersionedTransaction } from '@solana/web3.js';
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
