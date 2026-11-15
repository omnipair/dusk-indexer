import test from 'node:test';
import assert from 'node:assert/strict';
import { foldPortfolioAttribution } from '../services/duskPortfolioAttributionMath';
import type { AttributionBoundary,AttributionPayment } from '../services/duskPortfolioAttributionMath';

const boundary=(swap:string,interest:string,debt:string):AttributionBoundary=>({
  income:{streams:[{owner:'owner',holder:'owner',market:'market',lpMint:'lp',assetMint:'asset',assetDecimals:0,
    swapFeeAmount:swap,interestAmount:interest,sourceSlot:'100',sourceTime:'2026-11-15T00:00:00Z'}],unavailable:[]},
  interest:[{position:'position',market:'market',mint:'asset',decimals:0,amount:debt}],
});
const payment=(eventKey:string,kind:'yield'|'interest',interest:string,swap='0'):AttributionPayment=>({
  eventKey,kind,market:'market',mint:'asset',decimals:0,swap,interest,
});
const calculate=(start:AttributionBoundary,end:AttributionBoundary,payments:AttributionPayment[]=[],priced=true)=>
  foldPortfolioAttribution({start,end,payments,prices:priced?[{market:'market',mint:'asset',decimals:0,priceUsd:'2'}]:[]});

test('range income includes paid yield once plus the change in claimable amounts',()=>{
  const result=calculate(boundary('5','2','0'),boundary('7','4','3'),[payment('yield','yield','1','3')]);
  assert.equal(result.swapFeeUsd,'10');assert.equal(result.interestEarnedUsd,'6');
  assert.equal(result.earnedUsd,'16');assert.equal(result.borrowingCostUsd,'6');
});
test('paying opening accrued interest is not a second expense or a principal repayment',()=>{
  const result=calculate(boundary('0','0','10'),boundary('0','0','0'),[payment('repayment','interest','10')]);
  assert.equal(result.borrowingCostUsd,'0');
});
test('fully withdrawn liquidity and closed debt retain income and interest paid in the range',()=>{
  const closed:AttributionBoundary={income:{streams:[],unavailable:[]},interest:[]};
  const result=calculate(boundary('2','1','1'),closed,[payment('claim','yield','4','6'),payment('close','interest','3')]);
  assert.equal(result.earnedUsd,'14');assert.equal(result.borrowingCostUsd,'4');
});
test('price changes in unchanged old balances do not become new income or interest expense',()=>{
  const result=calculate(boundary('10','20','30'),boundary('10','20','30'));
  assert.equal(result.earnedUsd,'0');assert.equal(result.borrowingCostUsd,'0');
});
test('missing income history leaves borrowing cost usable, and missing prices never become zero dollars',()=>{
  const start=boundary('0','0','0');start.income=null;
  const result=calculate(start,boundary('2','3','4'),[payment('unknown-income','yield','3')]);
  assert.equal(result.earnedUsd,null);assert.equal(result.borrowingCostUsd,'8');
  const unpriced=calculate(boundary('0','0','0'),boundary('2','3','4'),[],false);
  assert.equal(unpriced.earnedUsd,null);assert.equal(unpriced.borrowingCostUsd,null);
});
test('duplicate canonical payments are rejected and interest forgiveness stays a signed credit',()=>{
  assert.throws(()=>calculate(boundary('0','0','0'),boundary('0','0','0'),[payment('duplicate','interest','1'),payment('duplicate','interest','1')]),/Duplicate/);
  assert.equal(calculate(boundary('0','0','4'),boundary('0','0','1')).borrowingCostUsd,'-6');
});
