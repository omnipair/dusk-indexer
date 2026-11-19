import './duskLegacyTestProtocol';
import test from 'node:test';
import assert from 'node:assert/strict';
import { BN } from '@coral-xyz/anchor';
import { zeroIncomeSource } from '../services/duskPortfolioIncome';
import { marketLayoutVersion } from '../services/duskProtocolSchema';
import { checkpointFixture } from './duskYieldCheckpointFixtures';

function fixture(){
  assert.equal(marketLayoutVersion(),17,'Keep the deployed layout-17 income regression bound to its archived schema at cutover');
  const f=checkpointFixture(),market=f.market as Record<string,any>;
  for(const side of ['base','quote']){
    for(const field of ['swap_fee_growth_index_q64','interest_growth_index_q64'])market[`${side}_side`].fees[field]=new BN(0);
    for(const vault of ['base_hlp_vault','quote_hlp_vault'])for(const field of ['swap_fee_growth_index_q64','interest_growth_index_q64'])
      market[vault][`${side}_${field}`]=new BN(0);
  }
  const source=()=>{
    const saved=f.source();
    return {groups:[{...saved,marketAccount:saved.accounts.market!,preview:'AQ==',previewUnavailable:false,
      observedAt:saved.blockTime,accounts:[],basis:'simulation-post-state' as const}]};
  };
  return {market,source};
}
test('a saved layout-17 zero-income bank needs no layout-19 ledger',()=>{
  const f=fixture();
  assert.equal(f.market.base_side.fees.ledger,undefined);
  assert.equal(zeroIncomeSource(f.source()),true);
});
test('legacy unpaid books, units, paid indexes and archived epochs are never zero anchors',()=>{
  for(const key of ['unpaid','units','paid_per_unit_q64','epoch']){
    const f=fixture();f.market.income.books[0][key]=new BN(1);
    assert.equal(zeroIncomeSource(f.source()),false,key);
  }
});
test('legacy sub-atom receivable growth and carried interest cannot disappear',()=>{
  const growth=fixture();growth.market.income.books[1].growth[0].weighted_paid_q128[2]=new BN(1);
  assert.equal(zeroIncomeSource(growth.source()),false);
  const carried=fixture();carried.market.base_side.fees.unallocated_interest_liability=new BN(1);
  assert.equal(zeroIncomeSource(carried.source()),false);
});
test('legacy hLP holder growth remains income even if current srLP growth is zero',()=>{
  const f=fixture();f.market.quote_hlp_vault.base_interest_growth_index_q64=new BN(1);
  assert.equal(zeroIncomeSource(f.source()),false);
});
