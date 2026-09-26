import test from 'node:test';
import assert from 'node:assert/strict';
import { AnchorProvider, BN, Program, Wallet } from '@coral-xyz/anchor';
import { Connection, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { loadPinnedProtocol } from '../config/duskProtocol';
import {
  CapacityDependencies,
  captureMarketCapacities,
  parseBorrowHeadroom,
  parseHlpDepositCapacity,
  simulateCapacityPreview,
} from '../services/duskMarketCapacity';
import { duskRawIdl } from '../services/duskMarketSimulation';
import { encodeFixtureType, fixtureKey } from './duskYieldCheckpointFixtures';

const pin = loadPinnedProtocol();
const market = fixtureKey(120).toBase58(),baseMint = fixtureKey(121).toBase58(),quoteMint = fixtureKey(122).toBase58();
const baseHlpMint = fixtureKey(123).toBase58(),quoteHlpMint = fixtureKey(124).toBase58();
const input = { market,baseMint,quoteMint,baseDecimals: 9,quoteDecimals: 6,baseHlpMint,quoteHlpMint };
const builder = new Program(duskRawIdl(),new AnchorProvider(new Connection('http://127.0.0.1:1'),{} as Wallet,{}));
const discriminator = (name: string) => Buffer.from(duskRawIdl().instructions.find((row) => row.name === name)!.discriminator);

function hlpPreview(side: 'Base' | 'Quote',status = 'Ready',gross = 1000n,net = 990n,slot = 700) {
  return { market: new PublicKey(market),target_asset: { [side]: {} },hlp_mint: new PublicKey(side === 'Base' ? baseHlpMint : quoteHlpMint),
    slot: new BN(slot),epoch: new BN(3),status: { [status]: {} },funding_limit_gross: new BN(gross.toString()),funding_limit_net: new BN(net.toString()) };
}
function borrowPreview(debt: 'Base' | 'Quote',changes: Record<string, unknown> = {}) {
  return { collateral_asset: { [debt === 'Base' ? 'Quote' : 'Base']: {} },debt_asset: { [debt]: {} },
    collateral_amount: new BN(debt === 'Base' ? 1_000_000 : 1_000_000_000),collateral_value_nad: new BN('2500000000'),
    max_debt_by_health: new BN(1700),max_debt_by_cash: new BN(5000),max_debt_by_daily_limit: new BN(4000),max_debt: new BN(1700),
    max_borrow_amount: new BN(1700),projected_borrow_amount: new BN(1700),projected_debt_amount: new BN(1700),
    max_cf_bps: 6800,liquidation_cf_bps: 7500,...changes };
}
// The raw IDL coder hands back BN and PublicKey objects; the parsers see the same.
const decoded = (value: Record<string, unknown>) => value;

test('hLP deposit admission keeps the program status and funding limits for its own vault',() => {
  const parsed = parseHlpDepositCapacity(decoded(hlpPreview('Quote')),{ market,hlpMint: quoteHlpMint,side: 'quote',slot: 700 });
  assert.deepEqual(parsed,{ status: 'ready',fundingLimitGross: '1000',fundingLimitNet: '990',sourceSlot: 700 });
  assert.equal(parseHlpDepositCapacity(decoded(hlpPreview('Base','CashConstrained',0n,0n)),
    { market,hlpMint: baseHlpMint,side: 'base',slot: 700 }).status,'cashConstrained');
  const expected = { market,hlpMint: quoteHlpMint,side: 'quote' as const,slot: 700 };
  for (const [preview,reason] of [
    [hlpPreview('Base'),'another vault side'],
    [{ ...hlpPreview('Quote'),market: fixtureKey(9) },'another market'],
    [hlpPreview('Quote','Ready',1000n,990n,701),'another bank'],
    [hlpPreview('Quote','Ready',10n,11n),'net above gross'],
    [hlpPreview('Quote','Ready',0n,0n),'ready without capacity'],
    [hlpPreview('Quote','RebalanceRequired',5n,5n),'blocked with capacity'],
    [hlpPreview('Quote','Paused'),'unknown status'],
  ] as const)
    assert.throws(() => parseHlpDepositCapacity(decoded(preview as Record<string, unknown>),expected),/Invalid hLP deposit capacity/,reason);
});

test('borrow headroom is the program quote for one whole collateral token',() => {
  const parsed = parseBorrowHeadroom(decoded(borrowPreview('Base')),{ debtAsset: 'base',referenceCollateralAmount: 1_000_000n,slot: 702 });
  assert.deepEqual(parsed,{ collateralAsset: 'quote',referenceCollateralAmount: '1000000',collateralValueNad: '2500000000',
    maxDebtByHealth: '1700',maxDebtByCash: '5000',maxDebtByDailyLimit: '4000',maxDebt: '1700',maxCfBps: 6800,liquidationCfBps: 7500,sourceSlot: 702 });
  const expected = { debtAsset: 'base' as const,referenceCollateralAmount: 1_000_000n,slot: 702 };
  for (const [changes,reason] of [
    [{ max_debt: new BN(1800),projected_borrow_amount: new BN(1800) },'max debt is not the lowest limit'],
    [{ collateral_amount: new BN(5) },'another collateral amount'],
    [{ projected_borrow_amount: new BN(1) },'a projected draw instead of the maximum'],
    [{ max_cf_bps: 8000 },'max above the liquidation factor'],
    [{ debt_asset: { Quote: {} } },'another debt asset'],
  ] as const)
    assert.throws(() => parseBorrowHeadroom(decoded(borrowPreview('Base',changes)),expected),/Invalid borrow capacity/,reason);
  assert.throws(() => parseBorrowHeadroom(decoded(borrowPreview('Base',{ liquidation_cf_bps: 10_001 })),expected),/capacity factor/);
});

function rpc(respond: (name: string, data: Buffer, accounts: string[]) => { err?: unknown; data?: Buffer; slot?: number; programId?: string } | Error) {
  const calls: string[] = [];
  const connection = {
    calls,
    simulateTransaction: async (transaction: VersionedTransaction, config: { minContextSlot?: number }) => {
      const message = transaction.message,ix = message.compiledInstructions.at(-1)!;
      const program = message.staticAccountKeys[ix.programIdIndex].toBase58();
      assert.equal(program,pin.dusk.programId);
      const data = Buffer.from(ix.data),name = ['preview_hlp_deposit_capacity','preview_borrow_capacity']
        .find((candidate) => discriminator(candidate).equals(data.subarray(0,8)))!;
      calls.push(`${name}:${data.subarray(8).toString('hex')}`);
      const result = respond(name,data.subarray(8),ix.accountKeyIndexes.map((index) => message.staticAccountKeys[index].toBase58()));
      if (result instanceof Error) throw result;
      return { context: { slot: result.slot ?? config.minContextSlot! },
        value: { err: result.err ?? null,logs: [],accounts: null,unitsConsumed: 0,
          returnData: result.data ? { programId: result.programId ?? pin.dusk.programId,data: [result.data.toString('base64'),'base64'] } : null } };
    },
  };
  return connection as typeof connection & CapacityDependencies['rpc'];
}

test('a rejected preview is unavailable while transport and foreign return data fail the read',async () => {
  const instruction = await builder.methods.previewHlpDepositCapacity().accountsStrict({ market: new PublicKey(market),
    futarchyAuthority: fixtureKey(1),baseMint: new PublicKey(baseMint),quoteMint: new PublicKey(quoteMint),targetHlpMint: new PublicKey(baseHlpMint) }).instruction();
  const payer = fixtureKey(80).toBase58();
  assert.equal(await simulateCapacityPreview({ rpc: rpc(() => ({ err: { InstructionError: [2,{ Custom: 6000 }] } })),payer },instruction,700),null);
  await assert.rejects(simulateCapacityPreview({ rpc: rpc(() => ({ data: Buffer.alloc(8),slot: 699 })),payer },instruction,700),/behind the market snapshot/);
  await assert.rejects(simulateCapacityPreview({ rpc: rpc(() => ({ data: Buffer.alloc(8),programId: fixtureKey(3).toBase58() })),payer },instruction,700),/no program data/);
  await assert.rejects(simulateCapacityPreview({ rpc: rpc(() => new Error('socket hang up')),payer },instruction,700),/socket hang up/);
});

test('each vault and debt asset is previewed separately and one failure leaves only its own capacity unknown',async () => {
  const connection = rpc((name,args,accounts) => {
    if (name === 'preview_hlp_deposit_capacity') {
      // Base vault admission fails at the program; quote is admitted.
      return accounts[4] === baseHlpMint
        ? { err: { InstructionError: [2,{ Custom: 6021 }] } }
        : { data: encodeFixtureType('HlpDepositCapacityPreview',hlpPreview('Quote',undefined,undefined,undefined,701)),slot: 701 };
    }
    const collateral = new BN(args.subarray(0,8),'le').toString();
    if (collateral === '1000000000') return new Error('rate limited');
    return { data: encodeFixtureType('BorrowCapacityPreview',borrowPreview('Base')),slot: 702 };
  });
  const capacities = await captureMarketCapacities(input,700,{ rpc: connection,payer: fixtureKey(80).toBase58() },builder);
  assert.equal(capacities.hlp.base,null);
  assert.deepEqual(capacities.hlp.quote,{ status: 'ready',fundingLimitGross: '1000',fundingLimitNet: '990',sourceSlot: 701 });
  // Borrowing base posts one whole quote token (6 decimals); borrowing quote posts one base token.
  assert.equal(capacities.borrow.base?.referenceCollateralAmount,'1000000');
  assert.equal(capacities.borrow.quote,null);
  assert.equal(connection.calls.length,4);
});
