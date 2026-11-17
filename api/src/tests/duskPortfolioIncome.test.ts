import test from 'node:test';
import assert from 'node:assert/strict';
import { BN,BorshCoder } from '@coral-xyz/anchor';
import { PublicKey } from '@solana/web3.js';
import { duskRawIdl } from '../services/duskMarketSimulation';
import type { MarketSimulationSnapshot } from '../services/duskMarketSimulation';
import { marketLayoutVersion } from '../services/duskProtocolSchema';
import { projectPortfolioIncome,incomeAddresses,zeroIncomeSource } from '../services/duskPortfolioIncome';
import type { PortfolioIncomeEvidence,PortfolioIncomeItem } from '../services/duskPortfolioIncome';
import { checkpointFixture,encodeFixtureAccount } from './duskYieldCheckpointFixtures';

function fixture(balance=3n){
  const f=checkpointFixture();f.market.version=marketLayoutVersion();const saved=f.source(900000001,balance);
  const item:PortfolioIncomeItem={address:f.lpTokenAccount,holder:f.owner,owner:f.owner,market:saved.market,lpMint:String(f.market.srlp_mint),
    kind:'srlp',baseMint:String((f.market.base_side as any).asset_mint),quoteMint:String((f.market.quote_side as any).asset_mint)};
  const addresses=incomeAddresses(item);
  const group:MarketSimulationSnapshot={commitment:'finalized',market:saved.market,slot:saved.slot,blockhash:saved.blockhash,blockTime:saved.blockTime,
    observedAt:saved.blockTime,deploymentIdentitySha256:saved.deploymentIdentitySha256,marketAccount:saved.accounts.market!,
    accounts:[{address:item.address,account:saved.accounts.lpToken}],basis:'simulation-post-state',preview:'AQ==',previewUnavailable:false};
  const evidence:PortfolioIncomeEvidence={items:[item],accounts:[{address:addresses[1],account:saved.accounts.yield},{address:addresses[2],account:null}],archives:[]};
  return {f,group,evidence};
}

test('funded yield replays from recorded same-bank bytes without a current account read',()=>{
  const {group,evidence}=fixture(),result=projectPortfolioIncome(group,evidence);
  assert.deepEqual(result.unavailable,[]);assert.equal(result.streams.length,2);
  assert.equal(result.streams[0].swapFeeAmount,'11');assert.equal(result.streams[0].interestAmount,'10');
  assert.equal(result.streams[1].swapFeeAmount,'0');
});
test('a zero token holding retains already accrued yield after a full withdrawal',()=>{
  const {group,evidence}=fixture(0n),result=projectPortfolioIncome(group,evidence);
  assert.equal(result.streams[0].swapFeeAmount,'5');assert.equal(result.streams[0].interestAmount,'7');
});
test('income source identity, account completeness and native precision fail closed',()=>{
  const {group,evidence}=fixture();
  const bad=structuredClone(evidence);bad.items[0].holder=PublicKey.default.toBase58();
  assert.throws(()=>projectPortfolioIncome(group,bad),/incomplete|differs/);
  const duplicate=structuredClone(evidence);duplicate.accounts.push(duplicate.accounts[0]);
  assert.throws(()=>projectPortfolioIncome(group,duplicate),/duplicated/);
  const missing=structuredClone(evidence);missing.accounts.pop();
  assert.throws(()=>projectPortfolioIncome(group,missing),/incomplete/);
});
test('unavailable program previews and missing archives remain unavailable, never zero income',()=>{
  const {group,evidence}=fixture();
  assert.equal(projectPortfolioIncome({...group,preview:null,previewUnavailable:true},evidence).unavailable.length,1);
  const unavailable=projectPortfolioIncome(group,{...evidence,archivesUnavailable:true});
  assert.equal(unavailable.streams.length,0);assert.equal(unavailable.unavailable.length,1);
});
test('legacy zero anchors require every growth and income ledger to establish zero',()=>{
  const {group}=fixture(),coder=new BorshCoder(duskRawIdl());
  const market=coder.accounts.decode('Market',Buffer.from(group.marketAccount.data,'base64')) as Record<string,any>;
  assert.equal(zeroIncomeSource({groups:[group]}),false);
  for(const side of ['base','quote'])for(const field of ['swap_fee_growth_index_q64','interest_growth_index_q64'])market[`${side}_side`].fees[field]=new BN(0);
  const zero={...group,marketAccount:{...group.marketAccount,data:encodeFixtureAccount('Market',market).toString('base64')}};
  assert.equal(zeroIncomeSource({groups:[zero]}),true);
  market.income.books[0].unpaid=new BN(1);
  assert.equal(zeroIncomeSource({groups:[{...zero,marketAccount:{...zero.marketAccount,data:encodeFixtureAccount('Market',market).toString('base64')}}]}),false);
});
