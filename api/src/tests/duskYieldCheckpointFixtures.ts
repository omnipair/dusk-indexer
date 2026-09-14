import { BN, Idl } from '@coral-xyz/anchor';
import type { IdlType, IdlTypeDef } from '@coral-xyz/anchor/dist/cjs/idl';
import { IdlCoder } from '@coral-xyz/anchor/dist/cjs/coder/borsh/idl';
import { PublicKey } from '@solana/web3.js';
import { AccountLayout, AccountState, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadPinnedProtocol } from '../config/duskProtocol';
import type { YieldCheckpointSource } from '../services/duskYieldCheckpoints';

const idl = JSON.parse(readFileSync(resolve(__dirname,'../../../protocol/idl/dusk.json'),'utf8')) as Idl;
export const Q64 = 1n<<64n;
export const fixtureKey = (byte: number) => new PublicKey(Buffer.alloc(32,byte));

// Generate neutral, encodable values for unrelated fields from the pinned IDL.
// The fields under test are explicitly populated below.
function zeroType(type: IdlType): unknown {
  if (typeof type === 'string') {
    if (type === 'pubkey') return fixtureKey(0);
    if (type === 'bool') return false;
    if (type === 'string') return '';
    if (type === 'bytes') return Buffer.alloc(0);
    return ['u64','i64','u128','i128','u256','i256'].includes(type) ? new BN(0) : 0;
  }
  if ('option' in type || 'coption' in type) return null;
  if ('vec' in type) return [];
  if ('array' in type) return Array.from({ length: type.array[1] as number },() => zeroType(type.array[0]));
  if ('defined' in type) return zeroDefinition(idl.types!.find((definition) => definition.name === type.defined.name)!);
  throw new Error('Unsupported fixture IDL type');
}
function zeroDefinition(definition: IdlTypeDef): Record<string, unknown> {
  if (definition.type.kind === 'struct') return Object.fromEntries((definition.type.fields ?? []).map((field) => {
    if (typeof field !== 'object' || !('name' in field)) throw new Error('Unexpected fixture tuple');
    return [field.name,zeroType(field.type)];
  }));
  if (definition.type.kind === 'enum') return { [definition.type.variants[0].name]: {} };
  throw new Error('Unsupported fixture definition');
}
export function encodeFixtureType(name: string, changes: Record<string,unknown> = {}): Buffer {
  const definition = idl.types!.find((type) => type.name === name)!;
  const value = { ...zeroDefinition(definition),...changes };
  const buffer = Buffer.alloc(32_768);
  const length = IdlCoder.typeDefLayout({ typeDef: definition,types: idl.types! }).encode(value,buffer);
  return buffer.subarray(0,length);
}
function encode(name: string, value: object): Buffer {
  const buffer = Buffer.alloc(32_768);
  const layout = IdlCoder.typeDefLayout({ typeDef: idl.types!.find((type) => type.name === name)!,types: idl.types! });
  const length = layout.encode(value,buffer);
  return Buffer.concat([Buffer.from(idl.accounts!.find((account) => account.name === name)!.discriminator),buffer.subarray(0,length)]);
}
export function encodeFixtureAccount(name: string,changes: Record<string,unknown>): Buffer {
  return Buffer.concat([Buffer.from(idl.accounts!.find((account) => account.name === name)!.discriminator),encodeFixtureType(name,changes)]);
}

export function checkpointFixture(options: { kind?: number; revenue?: 'base'|'quote'; lpSide?: 'base'|'quote' } = {}) {
  const pin = loadPinnedProtocol(), program = new PublicKey(pin.dusk.programId), kind = options.kind ?? 0;
  const owner = fixtureKey(111), base = fixtureKey(112), quote = fixtureKey(113), ylp = fixtureKey(114), baseHlp = fixtureKey(115), quoteHlp = fixtureKey(116);
  const paramsHash = Array.from({ length: 32 },(_,index) => index);
  const [marketAddress,marketBump] = PublicKey.findProgramAddressSync([Buffer.from('market_v2'),base.toBuffer(),quote.toBuffer(),Buffer.from(paramsHash)],program);
  const lpMint = kind === 0 ? ylp : options.lpSide === 'quote' ? quoteHlp : baseHlp;
  const assetMint = options.revenue === 'quote' ? quote : base;
  const [yieldAddress,yieldBump] = PublicKey.findProgramAddressSync([Buffer.from('yield'),marketAddress.toBuffer(),owner.toBuffer(),lpMint.toBuffer(),assetMint.toBuffer(),Buffer.from([kind])],program);
  const market = zeroDefinition(idl.types!.find((type) => type.name === 'Market')!);
  Object.assign(market,{ version: 2,ylp_mint: ylp,params_hash: paramsHash,bump: marketBump });
  for (const [side,mint,hlp,decimals] of [['base',base,baseHlp,9],['quote',quote,quoteHlp,6]] as const) {
    const state = market[`${side}_side`] as Record<string,unknown>;
    Object.assign(state,{ asset_mint: mint,hlp_mint: hlp,asset_decimals: decimals });
    Object.assign(state.fees as object,{ swap_fee_growth_index_q64: new BN((3n*Q64).toString()),interest_growth_index_q64: new BN((2n*Q64).toString()) });
    const vault = market[`${side}_hlp_vault`] as Record<string,unknown>;
    for (const revenue of ['base','quote']) {
      vault[`${revenue}_swap_fee_growth_index_q64`] = new BN((BigInt(revenue === 'base' ? 4 : 5)*Q64).toString());
      vault[`${revenue}_interest_growth_index_q64`] = new BN(Q64.toString());
    }
  }
  const yieldState = { ...zeroDefinition(idl.types!.find((type) => type.name === 'YieldAccount')!),owner,market: marketAddress,lp_mint: lpMint,asset_mint: assetMint,
    token_kind: kind,bump: yieldBump,recipient: fixtureKey(117),swap_fee_checkpoint_q64: new BN(Q64.toString()),interest_checkpoint_q64: new BN(Q64.toString()),
    accrued_swap_fee_amount: new BN(5),accrued_interest_amount: new BN(7),swap_fee_remainder_q64: new BN((Q64/2n).toString()),interest_remainder_q64: new BN(0) };
  const lpTokenAccount = getAssociatedTokenAddressSync(lpMint,owner,true,TOKEN_2022_PROGRAM_ID);
  const source = (slot = 900000001, balance = 3n): YieldCheckpointSource => {
    const token = Buffer.alloc(AccountLayout.span);
    AccountLayout.encode({ mint: lpMint,owner,amount: balance,delegateOption: 0,delegate: fixtureKey(0),state: AccountState.Initialized,
      isNativeOption: 0,isNative: 0n,delegatedAmount: 0n,closeAuthorityOption: 0,closeAuthority: fixtureKey(0) },token);
    return { yieldAddress: yieldAddress.toBase58(),market: marketAddress.toBase58(),lpTokenAccount: lpTokenAccount.toBase58(),slot,
      blockhash: fixtureKey(118).toBase58(),blockTime: new Date('2026-09-01T00:00:00Z').toISOString(),deploymentIdentitySha256: '1'.repeat(64),
      accounts: { yield: { owner: program.toBase58(),executable: false,data: encode('YieldAccount',yieldState).toString('base64') },
        market: { owner: program.toBase58(),executable: false,data: encode('Market',market).toString('base64') },
        lpToken: { owner: TOKEN_2022_PROGRAM_ID.toBase58(),executable: false,data: token.toString('base64') } } };
  };
  return { programId: program.toBase58(),yieldAddress: yieldAddress.toBase58(),yield: yieldState,market,owner: owner.toBase58(),
    lpTokenAccount: lpTokenAccount.toBase58(),lpBalance: '3',source };
}
