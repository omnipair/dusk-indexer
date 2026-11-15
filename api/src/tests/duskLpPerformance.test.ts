import test from 'node:test';
import assert from 'node:assert/strict';
import { foldLpCapital } from '../services/duskLpPerformance';
const owner='owner',market='market',lpMint='lp',base={mint:'base',decimals:0},quote={mint:'quote',decimals:0};
function event(name:string,slot:number,price='2',shares='100',amount='50') {
  const time=new Date(1_700_000_000_000+slot*1000).toISOString();
  return {eventKey:String(slot),eventName:name,market,signature:'tx'+slot,slot:String(slot),instructionPath:[0],eventOrdinal:0,time,
    payload:{owner,market,srlp_amount:shares,base_reserve_credit:amount,quote_reserve_credit:'0',base_owner_credit:amount,quote_owner_credit:'0'} as Record<string,unknown>,
    historicalPrices:{basis:'last-observed-before-event.v1' as const,asOf:time,prices:[{mint:'base',decimals:0,priceUsd:price,
      quality:'external-observation' as const,sourceTime:time,observedAt:time}]}};
}
const fold=(events:ReturnType<typeof event>[],balance='100',extra={})=>foldLpCapital({owner,market,lpMint,balance,base,quote,complete:true,changedOwnership:false,events,...extra});
test('remaining LP basis uses dated acquisitions and proportional realized withdrawals',()=>{
  const rows=[event('LiquidityAdded',1),event('LiquidityAdded',2,'4'),event('LiquidityRemoved',3,'2','50','55')];
  const result=fold(rows,'150');
  assert.equal(result.contributedUsd,'300');
  assert.equal(result.remainingBasisUsd,'225');
  assert.equal(result.withdrawnUsd,'110');
  assert.equal(result.realizedCapitalPnlUsd,'35');
  assert.deepEqual(fold([...rows].reverse(),'150'),result,'arrival order never changes the ledger');
});
test('paid yield is separate from capital and uses recipient credit at claim time',()=>{
  const claim=event('YieldClaimed',2,'4');
  claim.payload={owner,market,token_kind:'0',lp_mint:lpMint,asset_mint:'base',recipient_credit:'10',swap_fee_amount:'8',interest_amount:'2'};
  const result=fold([event('LiquidityAdded',1),claim]);
  assert.equal(result.claimedYieldUsd,'40');
  assert.equal(result.remainingBasisUsd,'100');
  claim.payload.token_kind='1';
  assert.equal(fold([event('LiquidityAdded',1),claim]).claimedYieldUsd,'0','hLP income is not srLP income');
});
test('missing evidence, changed ownership and mismatched holdings never become a guessed basis',()=>{
  const row=event('LiquidityAdded',1);
  for(const extra of [{complete:false},{changedOwnership:true},{balance:'99'}])
    assert.equal(fold([row],'100',extra).remainingBasisUsd,null);
  row.historicalPrices.prices[0].observedAt=new Date(Date.parse(row.time)+1).toISOString();
  assert.equal(fold([row]).remainingBasisUsd,null);
  row.historicalPrices.prices=[];
  assert.equal(fold([row]).remainingBasisUsd,null);
  assert.equal(fold([event('LiquidityAdded',1),event('LiquidityAdded',1)]).remainingBasisUsd,null);
});
test('same-slot mixed transactions need ordering evidence; CPI order within one transaction is known',()=>{
  const add=event('LiquidityAdded',1),exit=event('LiquidityRemoved',1,'2','50','25');
  exit.eventKey='exit';exit.signature='different';exit.instructionPath=[1];
  assert.equal(fold([add,exit],'50').remainingBasisUsd,null);
  exit.signature=add.signature;
  assert.equal(fold([exit,add],'50').remainingBasisUsd,'50');
});
