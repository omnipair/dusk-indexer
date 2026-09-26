import test from 'node:test';
import assert from 'node:assert/strict';
import { BN } from '@coral-xyz/anchor';
import { IdlCoder } from '@coral-xyz/anchor/dist/cjs/coder/borsh/idl';
import {
  ACCOUNT_SIZE,
  AccountLayout,
  AccountType,
  ExtensionType,
  MintLayout,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  TRANSFER_FEE_CONFIG_SIZE,
  TransferFeeConfigLayout,
} from '@solana/spl-token';
import { Connection, PublicKey } from '@solana/web3.js';
import type { AccountInfo, SimulateTransactionConfig } from '@solana/web3.js';
import type { Dusk, Market, YieldAccount } from '@omnipair/dusk-sdk';
import { createVirtualBookRuntime, deriveYieldAccountAddress } from '../services/virtualBook/native';
import { captureOwnerYield, captureYieldGroup, ownerYieldDependencies } from '../services/duskOwnerYield';
import type { YieldGroup } from '../services/duskOwnerYield';
import { projectLiveYield } from '../services/duskYieldAccounting';
import type { DuskDeploymentEnvelope } from '../services/duskDeploymentService';

const key = (n: number) => new PublicKey(Buffer.alloc(32, n));
const Q = 1n << 64n;

async function fixture(hlp = false, taxed = false) {
  const owner = key(51),
    marketAddress = key(52),
    base = key(53),
    quote = key(54),
    ylp = key(55),
    hlpMint = key(56);
  const lpMint = hlp ? hlpMint : ylp,
    kind = hlp ? ('hlp' as const) : ('ylp' as const);
  const response = {
    context: { slot: 1010 },
    value: {
      err: null as unknown,
      logs: [],
      unitsConsumed: 0,
      accounts: [] as ({ owner: string; executable: boolean; lamports: number; data: string[] } | null)[],
      returnData: { programId: '', data: ['', 'base64'] as [string, string] },
    },
  };
  const simulations: SimulateTransactionConfig[] = [];
  const connection = {
    simulateTransaction: async (_tx: unknown, config: SimulateTransactionConfig) => {
      simulations.push(config);
      return response;
    },
  };
  const { dusk } = await createVirtualBookRuntime(connection as unknown as Connection);
  response.value.returnData.programId = dusk.program.programId.toBase58();
  const layout = (name: string) =>
    IdlCoder.typeDefLayout({ typeDef: dusk.program.idl.types!.find((type) => type.name === name)!, types: dusk.program.idl.types! });
  const encodeType = (name: string, value: unknown) => {
    const bytes = Buffer.alloc(32768),
      length = layout(name).encode(value, bytes);
    return bytes.subarray(0, length);
  };
  const discriminator = (name: string) => Buffer.from(dusk.program.idl.accounts!.find((account) => account.name === name)!.discriminator);
  const coder = dusk.program.coder.accounts;
  const blank = <T>(name: string) => {
    const bytes = Buffer.alloc(coder.size(name));
    bytes.set(discriminator(name));
    return coder.decode<T>(name, bytes);
  };
  const market = blank<Market>('market');
  market.version = 1;
  market.ylpMint = ylp;
  market.baseSide.assetMint = base;
  market.quoteSide.assetMint = quote;
  market.baseSide.hlpMint = hlpMint;
  market.quoteSide.hlpMint = key(57);
  market.baseSide.assetDecimals = market.quoteSide.assetDecimals = 9;
  market.baseSide.shares.ylpSupply = market.quoteSide.shares.ylpSupply = new BN(100);
  market.baseSide.fees.swapFeeGrowthIndexQ64 = new BN((Q / 2n).toString());
  market.baseSide.fees.unallocatedSwapFeeLiability = new BN(50);
  market.baseSide.fees.interestGrowthIndexQ64 = new BN(Q.toString());
  market.baseHlpVault.ylpShares = new BN(20);
  market.baseHlpVault.hlpSupply = new BN(10);
  const yields = [base, quote].map((asset) => {
    const account = blank<YieldAccount>('yieldAccount');
    const [address, bump] = deriveYieldAccountAddress(marketAddress, owner, lpMint, asset, kind, dusk.program.programId);
    Object.assign(account, { owner, market: marketAddress, lpMint, assetMint: asset, recipient: owner, tokenKind: hlp ? 1 : 0, bump });
    return { address, account };
  });
  yields[0].account.accruedSwapFeeAmount = new BN(2);
  yields[0].account.accruedInterestAmount = new BN(1);
  const raw = (program: PublicKey, data: Buffer): AccountInfo<Buffer> => ({ owner: program, executable: false, lamports: 10_000_000, data });
  const mint = (authority: PublicKey, program: PublicKey, withFee = false) => {
    const data = Buffer.alloc(withFee ? ACCOUNT_SIZE + 5 + TRANSFER_FEE_CONFIG_SIZE : MintLayout.span);
    MintLayout.encode({ mintAuthorityOption: 1, mintAuthority: authority, supply: 100n, decimals: 9, isInitialized: true,
      freezeAuthorityOption: 0, freezeAuthority: PublicKey.default }, data);
    if (withFee) {
      data[ACCOUNT_SIZE] = AccountType.Mint;
      data.writeUInt16LE(ExtensionType.TransferFeeConfig, ACCOUNT_SIZE + 1);
      data.writeUInt16LE(TRANSFER_FEE_CONFIG_SIZE, ACCOUNT_SIZE + 3);
      const fee = { epoch: 0n, maximumFee: 20n, transferFeeBasisPoints: 100 };
      TransferFeeConfigLayout.encode({ transferFeeConfigAuthority: owner, withdrawWithheldAuthority: owner, withheldAmount: 0n,
        olderTransferFee: fee, newerTransferFee: fee }, data.subarray(ACCOUNT_SIZE + 5));
    }
    return raw(program, data);
  };
  const lpData = Buffer.alloc(AccountLayout.span);
  AccountLayout.encode({ mint: lpMint, owner, amount: 3n, delegateOption: 0, delegate: PublicKey.default, state: 1, isNativeOption: 0,
    isNative: 0n, delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default }, lpData);
  const clock = Buffer.alloc(40);
  clock.writeBigUInt64LE(1010n);
  clock.writeBigUInt64LE(9n, 16);
  const serialize = (info: AccountInfo<Buffer> | null) =>
    info ? { ...info, owner: info.owner.toBase58(), data: [info.data.toString('base64'), 'base64'] } : null;
  // Accounts are allocated at their full size; an empty Option leaves zero padding.
  const encodeAccount = (name: string, value: unknown) => {
    const data = Buffer.concat([discriminator(name), encodeType(name, value)]);
    return raw(dusk.program.programId, Buffer.concat([data, Buffer.alloc(Math.max(0, coder.size(name) - data.length))]));
  };
  const encode = () => {
    response.value.accounts = [
      encodeAccount('market', market),
      mint(marketAddress, TOKEN_2022_PROGRAM_ID),
      raw(TOKEN_2022_PROGRAM_ID, lpData),
      ...yields.map((row) => encodeAccount('yieldAccount', row.account)),
      mint(owner, taxed ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID, taxed),
      mint(owner, TOKEN_PROGRAM_ID),
      raw(new PublicKey('Sysvar1111111111111111111111111111111111111'), clock),
    ].map(serialize);
    const preview = layout('marketPreview').decode(Buffer.alloc(32768));
    preview.slot = new BN(1010);
    response.value.returnData.data[0] = encodeType('marketPreview', preview).toString('base64');
  };
  encode();
  const group: YieldGroup = { holder: owner.toBase58(), market: marketAddress.toBase58(), lpMint: lpMint.toBase58(), kind,
    baseMint: base.toBase58(), quoteMint: quote.toBase58() };
  return { dusk: dusk as Dusk, market, yields, response, encode, group, simulations, payer: owner.toBase58() };
}

test('live yield carries undistributed growth forward and checkpoints both hLP layers', async () => {
  const normal = await fixture(),
    hedged = await fixture(true);
  assert.deepEqual(projectLiveYield(normal.market, normal.yields[0].account, 3n),
    { side: 'base', swapFeeAmount: 5n, interestAmount: 4n, totalAmount: 9n });
  assert.deepEqual(projectLiveYield(hedged.market, hedged.yields[0].account, 3n),
    { side: 'base', swapFeeAmount: 8n, interestAmount: 7n, totalAmount: 15n });
  hedged.yields[0].account.tokenKind = 0;
  assert.throws(() => projectLiveYield(hedged.market, hedged.yields[0].account, 3n), /yLP/);
});

test('a group is valued in one updated bank with transfer fees applied to fees and interest separately', async () => {
  const f = await fixture(false, true);
  const streams = (await captureYieldGroup(f.dusk, f.group, f.payer, 1005))!;
  assert.deepEqual(streams[0], {
    address: f.yields[0].address.toBase58(), holder: f.group.holder, market: f.group.market, lpMint: f.group.lpMint,
    assetMint: f.group.baseMint, kind: 'ylp', recipient: f.group.holder, initialized: true, needsGrowth: false,
    lpBalance: '3', lpDecimals: 9, assetDecimals: 9, swapFeeAmount: '5', interestAmount: '4', recipientCredit: '7', sourceSlot: 1010,
  });
  assert.equal(streams[1].recipientCredit, '0');
  assert.equal(f.simulations[0].minContextSlot, 1005);
  assert.equal((f.simulations[0].accounts as { addresses: string[] }).addresses.length, 8);
});

test('missing ledgers, the repaired old layout, rejected previews and changed identities', async () => {
  const f = await fixture();
  const old = Buffer.from(f.response.value.accounts[3]!.data[0], 'base64').subarray(0, 234);
  f.response.value.accounts[3]!.data[0] = old.toString('base64');
  f.response.value.accounts[4] = null;
  const [repaired, missing] = (await captureYieldGroup(f.dusk, f.group, f.payer, 1005))!;
  assert.equal(repaired.initialized, true); assert.equal(repaired.needsGrowth, true); assert.equal(repaired.swapFeeAmount, '5');
  assert.equal(missing.initialized, false); assert.equal(missing.swapFeeAmount, '0');
  const rejected = await fixture();
  rejected.response.value.err = { InstructionError: [2, { Custom: 6010 }] };
  assert.equal(await captureYieldGroup(rejected.dusk, rejected.group, rejected.payer, 1005), null);
  for (const change of [
    (g: Awaited<ReturnType<typeof fixture>>) => { g.yields[0].account.owner = key(99); g.encode(); },
    (g: Awaited<ReturnType<typeof fixture>>) => { g.yields[0].account.lpMint = key(99); g.encode(); },
    (g: Awaited<ReturnType<typeof fixture>>) => { g.response.value.accounts[3]!.owner = TOKEN_PROGRAM_ID.toBase58(); },
    (g: Awaited<ReturnType<typeof fixture>>) => { g.response.context.slot = 1004; },
  ]) {
    const g = await fixture();
    change(g);
    await assert.rejects(captureYieldGroup(g.dusk, g.group, g.payer, 1005));
  }
});

test('owner yield values every discovered group at or after the stream and names rejected markets', async () => {
  const f = await fixture(),
    escrow = { ...f.group, holder: key(70).toBase58(), kind: 'hlp' as const };
  const deps: typeof ownerYieldDependencies = {
    groups: async (owner) => {
      assert.equal(owner, f.group.holder);
      return { groups: [f.group, escrow], sourceSlot: 1003 };
    },
    group: async (dusk, group, payer, floor) => {
      assert.equal(floor, 1003);
      return group.holder === escrow.holder ? null : captureYieldGroup(dusk, group, payer, floor);
    },
  };
  const deployment = { sourceSlot: 1001, programUpgradeAuthority: f.payer } as DuskDeploymentEnvelope;
  const result = await captureOwnerYield(f.dusk, f.group.holder, deployment, undefined, deps);
  assert.equal(result.schemaVersion, 'dusk-owner-yield.v1');
  assert.equal(result.streams.length, 2);
  assert.deepEqual(result.unavailable, [{ holder: escrow.holder, market: escrow.market, lpMint: escrow.lpMint }]);
  assert.equal(result.sourceSlot, 1010);
  assert.equal(result.expiresAt - result.observedAt, 15_000);
});
