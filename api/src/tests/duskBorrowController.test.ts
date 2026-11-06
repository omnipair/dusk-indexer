import test from 'node:test';
import assert from 'node:assert/strict';
import { convertIdlToCamelCase } from '@coral-xyz/anchor/dist/cjs/idl';
import { BorshCoder,BN } from '@coral-xyz/anchor';
import type { Market } from '@omnipair/dusk-sdk';
import { portfolioFixture } from './duskPortfolioFixtures';
import { duskRawIdl } from '../services/duskMarketSimulation';
import { projectBorrowController } from '../services/duskBorrowController';
const n = (value: string|number) => new BN(String(value));
function fixture() {
  const raw = portfolioFixture().source.groups[0].marketAccount;
  const market = new BorshCoder(convertIdlToCamelCase(duskRawIdl())).accounts.decode<Market>('market',Buffer.from(raw.data,'base64'));
  market.amm.priceEmaNad=n(1_000_000_000);
  market.baseSide.assetDecimals=market.quoteSide.assetDecimals=6;
  market.baseSide.reserves.cashReserve=n(80_000000);market.quoteSide.reserves.cashReserve=n(150_000000);
  market.baseSide.reserves.liveReserve=n(100_000000);market.quoteSide.reserves.liveReserve=n(200_000000);
  market.baseSide.shares.srlpSupply=n(100);market.tranches.juniorReserveShares=n(25);
  const d=market.debt;d.baseBorrowIndexNad=d.quoteBorrowIndexNad=n(1_000_000_000);
  d.fixedBaseShares=n(10_000000);d.fixedBasePrincipal=n(5_000000);
  d.isolatedBaseShares=n(20_000000);d.isolatedBasePrincipal=n(15_000000);
  d.fixedQuoteShares=d.fixedQuotePrincipal=n(100_000000);
  d.isolatedQuoteShares=d.isolatedQuotePrincipal=n(50_000000);
  market.quoteHlpVault.debtShares=n(3_000000);market.baseHlpVault.debtShares=n(7_000000);
  market.baseSide.fees.publicInterestAdvance.outstandingGross=n(4_000000);
  market.quoteSide.fees.publicInterestAdvance.outstandingGross=n(0);
  return market;
}
test('coverage excludes unfunded public interest, includes cash advances and both public/hLP debt books',()=>{
  const value=projectBorrowController(fixture(),123)!;
  assert.equal(value.sourceSlot,123);
  assert.equal(value.fundedJuniorValueNad,'73500000000');
  assert.equal(value.totalCoveredDebtValueNad,'190000000000');
  assert.equal(value.base.coveredDebtRaw,'33000000');
  assert.equal(value.quote.coveredDebtRaw,'157000000');
  assert.equal(value.base.signalNad,'273884210');
});
test('no junior backing produces zero coverage for indebted assets, while no debt holds',()=>{
  const market=fixture();market.tranches.juniorReserveShares=n(0);
  assert.equal(projectBorrowController(market,1)!.base.signalNad,'0');
  market.debt.fixedBaseShares=market.debt.isolatedBaseShares=market.quoteHlpVault.debtShares=n(0);
  market.baseSide.fees.publicInterestAdvance.outstandingGross=n(0);
  assert.equal(projectBorrowController(market,2)!.base.signalNad,null);
});
test('invalid backing is rejected and an unpriced unlaunched market has no controller valuation',()=>{
  const market=fixture();market.baseSide.fees.publicInterestAdvance.outstandingGross=n(20_000000);
  assert.throws(()=>projectBorrowController(market,1),/Invalid funded/);
  market.amm.priceEmaNad=market.risk.basePriceEmaNad=market.amm.launchReferencePriceNad=n(0);
  assert.equal(projectBorrowController(market,2),null);
});
