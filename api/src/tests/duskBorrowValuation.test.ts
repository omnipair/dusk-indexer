import test from 'node:test';
import assert from 'node:assert/strict';
import { BN } from '@coral-xyz/anchor';
import { IdlCoder } from '@coral-xyz/anchor/dist/cjs/coder/borsh/idl';
import { Connection, PublicKey, SYSVAR_CLOCK_PUBKEY } from '@solana/web3.js';
import type { AccountInfo, SimulateTransactionConfig, VersionedTransaction } from '@solana/web3.js';
import type { Dusk } from '@omnipair/dusk-sdk';
import { createVirtualBookRuntime, deriveBorrowPositionAddress } from '../services/virtualBook/native';
import { captureBorrowValuation } from '../services/duskBorrowValuation';
import type { BorrowValuation } from '../services/duskBorrowValuation';
import { captureLiquidations, liquidationCaptureDependencies } from '../services/duskLiquidations';
import { displayKey } from './duskDisplayStateFixtures';
import type { DuskDeploymentEnvelope } from '../services/duskDeploymentService';

const CLOCK_OWNER = new PublicKey('Sysvar1111111111111111111111111111111111111');

async function fixture() {
  const state = {
    slot: 2000,
    err: null as unknown,
    clockSlot: undefined as number | undefined,
    owner: displayKey(71),
    auction: 255,
    simulations: [] as SimulateTransactionConfig[],
  };
  let dusk!: Dusk;
  const connection = {
    simulateTransaction: async (_transaction: VersionedTransaction, config: SimulateTransactionConfig) => {
      state.simulations.push(config);
      const clock = Buffer.alloc(40);
      clock.writeBigUInt64LE(BigInt(state.clockSlot ?? state.slot));
      clock.writeBigInt64LE(1_790_000_000n, 32);
      const serialize = (account: AccountInfo<Buffer>) => ({ ...account, owner: account.owner.toBase58(), data: [account.data.toString('base64'), 'base64'] });
      return {
        context: { slot: state.slot },
        value: {
          err: state.err,
          logs: [],
          unitsConsumed: 0,
          returnData: { programId: dusk.program.programId.toBase58(), data: [preview().toString('base64'), 'base64'] },
          accounts: [
            serialize(encode('market', market, 'account')),
            serialize(encode('borrowPosition', { ...position, owner: state.owner, auctionDebtAsset: state.auction }, 'account')),
            serialize({ owner: CLOCK_OWNER, executable: false, lamports: 1, data: clock }),
          ],
        },
      };
    },
  };
  ({ dusk } = await createVirtualBookRuntime(connection as unknown as Connection));
  const layout = (name: string) =>
    IdlCoder.typeDefLayout({ typeDef: dusk.program.idl.types!.find((t) => t.name === name)!, types: dusk.program.idl.types! });
  const encode = (name: string, value: unknown, kind: 'account' | 'type'): AccountInfo<Buffer> => {
    const buffer = Buffer.alloc(16384),
      length = layout(name).encode(value, buffer);
    const prefix = kind === 'account' ? Buffer.from(dusk.program.idl.accounts!.find((a) => a.name === name)!.discriminator) : Buffer.alloc(0);
    return { owner: dusk.program.programId, executable: false, lamports: 1e8, data: Buffer.concat([prefix, buffer.subarray(0, length)]) };
  };
  const marketAddress = displayKey(72),
    positionId = displayKey(73);
  const [address, bump] = deriveBorrowPositionAddress(marketAddress, positionId);
  const market = layout('market').decode(Buffer.alloc(16384));
  Object.assign(market, { version: 1 });
  const position = layout('borrowPosition').decode(Buffer.alloc(16384));
  Object.assign(position, {
    owner: state.owner,
    market: marketAddress,
    positionId,
    bump,
    baseCollateral: new BN(500),
    quoteCollateral: new BN(0),
    fixedBaseShares: new BN(0),
    fixedQuoteShares: new BN(90),
    auctionStartTime: new BN(1_789_999_900),
    auctionStartPriceNad: new BN(1_100_000_000),
    auctionFloorPriceNad: new BN(900_000_000),
  });
  const debtSide = (fixed: number, liquidatable: boolean) => ({
    debtAsset: { base: {} },
    collateralAsset: { quote: {} },
    fixedDebt: new BN(fixed),
    collateralAmount: new BN(500),
    globalHealthContribution: new BN(0),
    collateralValueNad: new BN(700),
    healthBps: new BN(7700),
    maxCfBps: 6000,
    liquidationCfBps: 7000,
    liquidationReferencePriceNad: new BN(1_000_000_000),
    liquidationHealthBps: new BN(9100),
    isLiquidatable: liquidatable,
    liquidationIncentiveBps: 0,
    insuranceFundingBps: 0,
    totalPenaltyBps: 0,
    maxRepayAmount: new BN(fixed / 2),
  });
  const previewValue = {
    owner: state.owner,
    market: marketAddress,
    positionId,
    baseCollateral: new BN(500),
    quoteCollateral: new BN(0),
    globalHealthBaseContributionForQuoteDebt: new BN(0),
    globalHealthQuoteContributionForBaseDebt: new BN(0),
    baseLiquidationCfBps: 7000,
    quoteLiquidationCfBps: 7000,
    fixedBaseDebt: new BN(0),
    fixedQuoteDebt: new BN(91),
    baseDebt: debtSide(0, false),
    quoteDebt: { ...debtSide(91, true), debtAsset: { quote: {} }, collateralAsset: { base: {} } },
  };
  const preview = () => encode('borrowPositionPreview', { ...previewValue, owner: state.owner }, 'type').data;
  const ref = { address: address.toBase58(), market: marketAddress.toBase58(), owner: state.owner.toBase58() };
  return { dusk, state, ref, previewValue };
}

test('a borrow valuation reads accrued debt, liquidation terms and auction state from one bank', async () => {
  const f = await fixture();
  const valuation = (await captureBorrowValuation(f.dusk, f.ref, 1990, displayKey(80).toBase58())) as BorrowValuation;
  assert.equal(valuation.status, 'available');
  assert.equal(valuation.positionId, displayKey(73).toBase58());
  assert.equal(valuation.fixedQuoteShares, '90');
  assert.equal(valuation.sourceSlot, 2000);
  assert.equal(valuation.unixTimestamp, '1790000000');
  assert.equal(valuation.auction, null);
  assert.deepEqual(valuation.quote, {
    fixedDebt: '91', collateralAmount: '500', collateralValueNad: '700', healthBps: '7700', maxCfBps: 6000,
    liquidationCfBps: 7000, liquidationReferencePriceNad: '1000000000', liquidationHealthBps: '9100',
    isLiquidatable: true, maxRepayAmount: '45',
  });
  assert.equal(f.state.simulations[0].minContextSlot, 1990);
  assert.deepEqual((f.state.simulations[0].accounts as { addresses: string[] }).addresses,
    [f.ref.market, f.ref.address, SYSVAR_CLOCK_PUBKEY.toBase58()]);
  f.state.auction = 1;
  const auctioned = (await captureBorrowValuation(f.dusk, f.ref, 1990, displayKey(80).toBase58())) as BorrowValuation;
  assert.deepEqual(auctioned.auction, { debtAsset: 'quote', startTime: '1789999900', startPriceNad: '1100000000', floorPriceNad: '900000000' });
});

test('a rejected preview is an unavailable row; a changed owner, bank or stale slot fails', async () => {
  const f = await fixture(),
    payer = displayKey(80).toBase58();
  f.state.err = { InstructionError: [2, { Custom: 6004 }] };
  assert.deepEqual(await captureBorrowValuation(f.dusk, f.ref, 1990, payer), {
    status: 'unavailable', ...f.ref, sourceSlot: 2000, reason: 'preview-rejected',
  });
  f.state.err = null;
  await assert.rejects(captureBorrowValuation(f.dusk, f.ref, 2001, payer), /behind its discovery/);
  f.state.clockSlot = 1999;
  await assert.rejects(captureBorrowValuation(f.dusk, f.ref, 1990, payer), /Clock bank mismatch/);
  f.state.clockSlot = undefined;
  await assert.rejects(captureBorrowValuation(f.dusk, { ...f.ref, owner: displayKey(79).toBase58() }, 1990, payer), /identity changed/);
});

test('liquidations publish only liquidatable or auctioned positions and keep rejected previews visible', async () => {
  const f = await fixture(),
    payer = displayKey(80).toBase58();
  const healthy = displayKey(90).toBase58(),
    rejected = displayKey(91).toBase58();
  const deps: typeof liquidationCaptureDependencies = {
    positions: async () => ({ positions: [f.ref, { ...f.ref, address: healthy }, { ...f.ref, address: rejected }], sourceSlot: 1995 }),
    valuation: async (dusk, position, floor) => {
      assert.equal(floor, 1995);
      if (position.address === rejected)
        return { status: 'unavailable', ...position, sourceSlot: 2001, reason: 'preview-rejected' };
      const valuation = (await captureBorrowValuation(dusk, f.ref, floor, payer)) as BorrowValuation;
      return position.address === healthy
        ? { ...valuation, address: healthy, quote: { ...valuation.quote, isLiquidatable: false } }
        : valuation;
    },
  };
  const deployment = { sourceSlot: 1990, programUpgradeAuthority: payer } as DuskDeploymentEnvelope;
  const result = await captureLiquidations(f.dusk, deployment, undefined, deps);
  assert.equal(result.schemaVersion, 'dusk-liquidations.v1');
  assert.deepEqual(result.candidates.map((row) => row.address), [f.ref.address]);
  assert.deepEqual(result.unavailable, [{ address: rejected, market: f.ref.market, sourceSlot: 2001 }]);
  assert.deepEqual(result.discovery, { sourceSlot: 1995, positions: 3 });
  assert.equal(result.sourceSlot, 2001);
  assert.equal(result.expiresAt - result.observedAt, 15_000);
  deps.valuation = async () => { throw new Error('RPC timeout'); };
  await assert.rejects(captureLiquidations(f.dusk, deployment, undefined, deps), /RPC timeout/);
  await assert.rejects(
    captureLiquidations(f.dusk, { ...deployment, programUpgradeAuthority: null }, undefined, deps),
    /preview payer/,
  );
});
