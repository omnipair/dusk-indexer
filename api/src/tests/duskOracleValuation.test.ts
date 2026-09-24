import test from 'node:test';
import assert from 'node:assert/strict';
import { oraclePositionValue } from '../services/duskOracleValuation';

const position = { collateralRaw: '490777716', marginRaw: '100000000', debtShares: '418816536',
  aggregateShares: '2000000000', borrowIndexNad: '1000516800', oraclePriceNad: '750000000',
  collateralDecimals: 6, debtDecimals: 6 };
test('underwater positions retain signed oracle equity and loss beyond margin', () => {
  const result = oraclePositionValue(position);
  assert.equal(result.collateralValueRaw, '368083287');
  assert.equal(result.debtRaw, '419032981');
  assert.equal(result.equityRaw, '-50949694');
  assert.equal(result.pnlRaw, '-150949694');
  assert.equal(result.underwater, true);
});
test('symmetric quote EMA and mixed decimals are used directly, never inverted', () => {
  const result = oraclePositionValue({ ...position, collateralRaw: '3000000000', collateralDecimals: 9,
    debtDecimals: 6, debtShares: '1000000', aggregateShares: '1000000', borrowIndexNad: '1000000000',
    marginRaw: '1000000', oraclePriceNad: '400000000' });
  assert.equal(result.collateralValueRaw, '1200000');
  assert.equal(result.pnlRaw, '-800000');
  assert.equal(result.underwater, false);
});
test('full repayment uses aggregate burn rounding and zero equity remains explicit', () => {
  const value = oraclePositionValue({ ...position, collateralRaw: '2', marginRaw: '1', debtShares: '1',
    aggregateShares: '2', borrowIndexNad: '1500000000', oraclePriceNad: '1000000000' });
  assert.equal(value.debtRaw, '2');
  assert.equal(value.equityRaw, '0');
  assert.equal(value.pnlRaw, '-1');
  assert.equal(value.underwater, true);
});
test('bad price, impossible shares, overflow and invalid precision are rejected', () => {
  for (const patch of [{ oraclePriceNad: '0' }, { aggregateShares: '1' }, { collateralDecimals: -1 },
    { borrowIndexNad: ((1n << 128n) - 1n).toString() }]) {
    assert.throws(() => oraclePositionValue({ ...position, ...patch }));
  }
});

import { BN, BorshCoder } from '@coral-xyz/anchor';
import { PublicKey } from '@solana/web3.js';
import type { Dusk } from '@omnipair/dusk-sdk';
import { loadPinnedProtocol } from '../config/duskProtocol';
import { captureOracleValuations } from '../services/duskOracleValuation';
import { duskRawIdl, type LiveMarketSimulationSnapshot } from '../services/duskMarketSimulation';
import type { DuskDeploymentEnvelope } from '../services/duskDeploymentService';
import { priceFixture } from './duskPriceFixtures';
import { encodeFixtureType, encodeFixtureAccount } from './duskYieldCheckpointFixtures';

test('a market batch captures one evaluated oracle for all rows, refuses changed positions and deployment, and marks failed previews unavailable', async () => {
  const source = priceFixture().source(), pin = loadPinnedProtocol(), coder = new BorshCoder(duskRawIdl());
  const market = coder.accounts.decode('Market', Buffer.from(source.rawMarket, 'base64'));
  market.base_side.asset_decimals = 6;
  market.debt.isolated_quote_shares = new BN('2000000000');
  market.debt.quote_borrow_index_nad = new BN('1000516800');
  const preview = coder.types.decode('MarketPreview', Buffer.from(source.rawPreview, 'base64'));
  for (const side of ['base', 'quote']) {
    preview[side].cash_reserve = market[side+'_side'].reserves.cash_reserve;
    preview[side].live_reserve = market[side+'_side'].reserves.live_reserve;
    preview[side].ylp_supply = market[side+'_side'].shares.ylp_supply;
    preview[side].borrow_index_nad = market.debt[side+'_borrow_index_nad'];
  }
  preview.base.price_ema_nad = new BN('750000000');
  const rows = [{ address: source.market, data: 'AQ==' }, { address: pin.dusk.programId, data: 'Ag==' }];
  const position = { market: new PublicKey(source.market), debtAsset: 1, collateralAmount: new BN('490777716'),
    marginAmount: new BN('100000000'), debtShares: new BN('418816536') };
  const dusk = { program: { coder: { accounts: { decode: () => position } } } } as unknown as Dusk;
  const deployment = { programId: pin.dusk.programId, deploymentIdentitySha256: source.deploymentIdentitySha256, sourceSlot: source.slot } as DuskDeploymentEnvelope;
  const snapshot: LiveMarketSimulationSnapshot = { commitment: 'confirmed', market: source.market, slot: source.slot,
    blockhash: source.blockhash, blockTime: source.blockTime, observedAt: source.observedAt,
    deploymentIdentitySha256: source.deploymentIdentitySha256, basis: 'simulation-post-state', previewUnavailable: false,
    marketAccount: { owner: pin.dusk.programId, executable: false, data: encodeFixtureAccount('Market', market).toString('base64') },
    preview: encodeFixtureType('MarketPreview', preview).toString('base64'),
    accounts: rows.map(row => ({ address: row.address, account: { owner: pin.dusk.programId, executable: false, data: row.data } })) };
  let calls = 0;
  const capture = async (address: string, slot: number, extra: string[] = []) => {
    calls++; assert.equal(address, source.market); assert.equal(slot, source.slot); assert.equal(extra.length, 2); return snapshot;
  };
  const result = await captureOracleValuations(dusk, rows, deployment, undefined, capture);
  assert.equal(calls, 1);
  assert.equal(result.length, 2);
  assert.ok(result.every(row => row.status === 'available' && row.pnlRaw === '-150949694'));
  snapshot.accounts[0].account!.data = 'Aw==';
  await assert.rejects(captureOracleValuations(dusk, rows, deployment, undefined, capture), /position changed/);
  snapshot.accounts[0].account!.data = rows[0].data;
  await assert.rejects(captureOracleValuations(dusk, rows, { ...deployment, deploymentIdentitySha256: 'f'.repeat(64) }, undefined, capture), /deployment changed/);
  snapshot.preview = null; snapshot.basis = 'rpc-account'; snapshot.previewUnavailable = true;
  const missing = await captureOracleValuations(dusk, rows, deployment, undefined, capture);
  assert.ok(missing.every(row => row.status === 'unavailable'));
});
