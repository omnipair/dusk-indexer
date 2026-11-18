import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LEGACY_RETIREMENT, RetirementAccount, RetirementReceipt,
  reconcileRetirementReceipts, retirementInventorySummary, retirementObservationHash } from '../services/duskRetirementInventory';

function fixture() {
  const accounts: RetirementAccount[] = [{address:LEGACY_RETIREMENT.market,kind:'Market',state:{version:17,
    srlp_mint:'sr',junior_mint:'jr',base_side:{hlp_mint:'hb'},quote_side:{hlp_mint:'hq'}}},
  {address:'position',kind:'LeveragePosition',state:{market:LEGACY_RETIREMENT.market,owner:'trader',debt_shares:'1',collateral_amount:'2'}},
  {address:'old-cohort',kind:'HlpCohort',state:{market:LEGACY_RETIREMENT.market,mint:'old'}}];
  const receipts: RetirementReceipt[] = ['sr','jr','hb','hq','old'].map(mint => ({mint,supply:'0',accounts:[]}));
  receipts[0] = {mint:'sr',supply:'9007199254740999',accounts:[
    {address:'non-ata',owner:'lp-only',amount:'9007199254740997',frozen:false},
    {address:'custody',owner:LEGACY_RETIREMENT.market,amount:'2',frozen:false}]};
  return {accounts,receipts};
}

test('inventory includes LP-only owners, retired mints and exact integers without paying custody as a wallet',() => {
  const f = fixture(),summary = retirementInventorySummary(f.accounts,f.receipts);
  assert.deepEqual(summary.owners,['lp-only','trader']);
  assert.equal(summary.receipts.find(row => row.mint === 'sr')?.enumeratedAmount,'9007199254740999');
  assert.equal(summary.openLeveragePositions,1);
  assert.equal(summary.settlementReady,false);
});
test('missing holder, duplicate account or duplicate mint never reconciles',() => {
  const f = fixture();
  const omitted = structuredClone(f.receipts); omitted[0].accounts.pop();
  assert.throws(() => reconcileRetirementReceipts(omitted),/Incomplete/);
  const duplicate = structuredClone(f.receipts); duplicate[0].accounts.push(duplicate[0].accounts[0]);
  assert.throws(() => reconcileRetirementReceipts(duplicate),/Duplicate/);
  assert.throws(() => reconcileRetirementReceipts([...f.receipts,f.receipts[0]]),/Duplicate/);
});
test('cannot omit a retired mint or change market/version',() => {
  const f = fixture();
  assert.throws(() => retirementInventorySummary(f.accounts,f.receipts.slice(0,-1)),/omitted/);
  f.accounts[0].state.version = 19;
  assert.throws(() => retirementInventorySummary(f.accounts,f.receipts),/layout-17/);
  f.accounts[0].state.version = 17;
  f.accounts[1].state.market = 'other-market';
  assert.throws(() => retirementInventorySummary(f.accounts,f.receipts),/crossed/);
});
test('zero debt with remaining collateral remains an open position; historical yield owners remain inventoried',() => {
  const f = fixture(); f.accounts[1].state.debt_shares = '0';
  f.accounts.push({address:'claim',kind:'YieldAccount',state:{market:LEGACY_RETIREMENT.market,owner:'former-lp'}});
  const summary = retirementInventorySummary(f.accounts,f.receipts);
  assert.equal(summary.openLeveragePositions,1);
  assert.deepEqual(summary.owners,['former-lp','lp-only','trader']);
});
test('negative, fractional or unsafe-number amounts are refused',() => {
  for (const amount of ['-1','1.5',Number.MAX_SAFE_INTEGER]) {
    const f = fixture(); f.receipts[0].accounts[0].amount = amount as string;
    assert.throws(() => reconcileRetirementReceipts(f.receipts),/Invalid/);
  }
});
test('frozen accounts remain in the claim inventory; observation digest binds balances and ownership',() => {
  const f = fixture(); const before = retirementObservationHash(f);
  f.receipts[0].accounts[0].frozen = true;
  assert.notEqual(retirementObservationHash(f),before);
  assert.equal(retirementInventorySummary(f.accounts,f.receipts).receipts.find(row => row.mint === 'sr')
    ?.accounts.find(row => row.address === 'non-ata')?.frozen,true);
});
