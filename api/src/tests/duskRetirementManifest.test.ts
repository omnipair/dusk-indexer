import { test } from 'node:test';
import assert from 'node:assert/strict';
import { proposedRetirementTokens, type RetirementProposalCatalog } from '../services/duskRetirementManifest';

// Small accounting examples for the proposal's fail-closed guards. They are
// not fixtures of the deployed program and do not prove an on-chain payout.
function example() {
  const fees=()=>({
    referralInterestLiability:'0',revenueInterestLiability:'0',unallocatedSwapFeeLiability:'0',unallocatedInterestLiability:'0',
    swapProtocolFeeLiability:'5',interestProtocolFeeLiability:'1',swapBuybackFeeLiability:'0',interestBuybackFeeLiability:'0',
    swapFeeLiability:'3',interestLiability:'1',junior:{seedSwapAmount:'2',seedInterestAmount:'1'},
  });
  const catalog:RetirementProposalCatalog={owners:['alice','bob'],yieldAccounts:['yield-a','yield-b'],
    receiptMints:['senior','junior','base-hlp','quote-hlp'],assetMints:['base','quote'],lockedSeniorShares:'1000'};
  const run={allLeverageClosed:true,strategy:'ordered-native-rehearsal',
    steps:catalog.yieldAccounts.map(yieldAccount=>({yieldAccount,pass:'after-junior',status:'income-no-current-payout-locally'})),
    remainingDebt:{fixedBaseShares:'0',fixedQuoteShares:'0',isolatedBaseShares:'0',isolatedQuoteShares:'0',
      fixedBasePrincipal:'0',fixedQuotePrincipal:'0',isolatedBasePrincipal:'0',isolatedQuotePrincipal:'0'},
    finalMarket:{
      operator:{revenueRecipient:'alice'},
      baseHlpVault:{hlpSupply:'0',debtShares:'0',debtPrincipal:'0',residualExposure:'0',flashCollateralDebit:'0'},
      quoteHlpVault:{hlpSupply:'0',debtShares:'0',debtPrincipal:'0',residualExposure:'0',flashCollateralDebit:'0'},
      tranches:{queuedReceipts:'0',juniorReceiptSupply:'20',permanentReceipts:'20',juniorReserveShares:'50'},
      baseSide:{shares:{srlpSupply:'1050'},fees:fees()},quoteSide:{fees:fees()},
      income:{books:Array.from({length:4},()=>({unpaid:'0'})),pending:['0','0','0','0'],revenue:Array.from({length:4},()=>({
        grossUnpaid:'0',protocolUnpaid:'0',operatorUnpaid:'0',pendingGross:'0',pendingProtocolGross:'0',operatorClaimable:'0',
      }))},
    },
    finalReceiptSupplies:catalog.receiptMints.map(mint=>({mint,supply:'0'})),
    finalEconomicAccounts:catalog.yieldAccounts.map(address=>({address,kind:'YieldAccount',
      state:{recipient:'alice',accrued_swap_fee_amount:'0',accrued_interest_amount:'0'}})),
    realizedOwnerTokens:[{owner:'alice',baseRaw:'101',quoteRaw:'9'},{owner:'bob',baseRaw:'99',quoteRaw:'91'}],
    tokenConservation:[{mint:'base',before:'300',after:'300'},{mint:'quote',before:'250',after:'250'}],
  };
  const custody={baseRaw:'300',quoteRaw:'250'};
  return {catalog,run,custody};
}

test('proposal conserves custody, retains 99% net minima and never grants execution authority',()=>{
  const {run,custody,catalog}=example();
  const result=proposedRetirementTokens(run,custody,catalog);
  assert.equal(result.executionReady,false);
  assert.equal(result.policy.liveExecutionAuthorized,false);
  assert.equal(result.users[0].minimumBaseRaw,'100');
  assert.equal(result.users[1].minimumBaseRaw,'99');
  assert.equal(result.treasury.baseRaw,'100');
  assert.equal(result.treasury.quoteRaw,'150');
  assert.equal(result.treasury.owner,result.policy.residualRecipient);
  assert.deepEqual(result.allocation.base,{
    sourceCustodyRaw:'300',usersRaw:'200',protocolFeesRaw:'6',permanentSeedIncomeRaw:'3',
    permanentIncomeAndRoundingRaw:'1',permanentCapitalRaw:'90',treasuryRaw:'100',
  });
});

test('an omitted, substituted or duplicate beneficiary cannot produce a payout proposal',()=>{
  for(const mutation of [
    (run:any)=>run.realizedOwnerTokens.pop(),
    (run:any)=>run.realizedOwnerTokens[1].owner='stranger',
    (run:any)=>run.realizedOwnerTokens[1].owner='alice',
  ]) {
    const {run,custody,catalog}=example();mutation(run);
    assert.throws(()=>proposedRetirementTokens(run,custody,catalog),/beneficiary catalog/);
  }
});

test('zero circulating supply is insufficient when a receipt mint or holder income account is omitted',()=>{
  const mutations=[
    (run:any)=>run.finalReceiptSupplies.pop(),
    (run:any)=>run.finalReceiptSupplies[1].mint='unrelated-mint',
    (run:any)=>run.finalEconomicAccounts.pop(),
    (run:any)=>run.finalEconomicAccounts[1].address='unrelated-yield',
    (run:any)=>run.steps.pop(),
    (run:any)=>run.steps[1].yieldAccount='unrelated-yield',
  ];
  for(const mutation of mutations) {
    const {run,custody,catalog}=example();mutation(run);
    assert.throws(()=>proposedRetirementTokens(run,custody,catalog),/catalog|claim replay/);
  }
});

test('unfinished closures, debt, funding and junior claims block residual disposition',()=>{
  const mutations=[
    (run:any)=>run.allLeverageClosed=false,
    (run:any)=>run.steps.push({status:'loan-rejected'}),
    (run:any)=>run.remainingDebt.fixedBaseShares='1',
    (run:any)=>run.finalMarket.baseHlpVault.debtPrincipal='1',
    (run:any)=>run.finalMarket.quoteHlpVault.residualExposure='1',
    (run:any)=>run.finalReceiptSupplies[0].supply='1',
    (run:any)=>run.finalMarket.tranches.queuedReceipts='1',
    (run:any)=>run.finalMarket.tranches.juniorReceiptSupply='21',
    (run:any)=>run.finalMarket.baseSide.shares.srlpSupply='1051',
    (run:any)=>delete run.remainingDebt.fixedBasePrincipal,
    (run:any)=>run.finalMarket.income.revenue.pop(),
  ];
  for(const mutation of mutations) {
    const {run,custody,catalog}=example();mutation(run);
    assert.throws(()=>proposedRetirementTokens(run,custody,catalog));
  }
});

test('an unpaid holder, operator, referral or protocol claim cannot be relabeled as treasury capital',()=>{
  const mutations=[
    (run:any)=>run.finalMarket.income.books[0].unpaid='1',
    (run:any)=>run.finalMarket.income.pending[0]='1',
    (run:any)=>run.finalMarket.income.revenue[0].operatorClaimable='1',
    (run:any)=>run.finalMarket.income.revenue[0].pendingProtocolGross='1',
    (run:any)=>run.finalEconomicAccounts[0].state.accrued_swap_fee_amount='1',
    (run:any)=>run.finalMarket.baseSide.fees.referralInterestLiability='1',
    (run:any)=>run.finalMarket.quoteSide.fees.unallocatedInterestLiability='1',
  ];
  for(const mutation of mutations) {
    const {run,custody,catalog}=example();mutation(run);
    assert.throws(()=>proposedRetirementTokens(run,custody,catalog),/Unpaid|Unresolved/);
  }
});

test('a changed harvest or operator recipient outside the catalog remains unclassified, never treasury residue',()=>{
  const first=example();first.run.finalEconomicAccounts[0].state.recipient='external-recipient';
  assert.throws(()=>proposedRetirementTokens(first.run,first.custody,first.catalog),/Unclassified income recipient/);
  const second=example();second.run.finalMarket.operator.revenueRecipient='external-operator';
  assert.throws(()=>proposedRetirementTokens(second.run,second.custody,second.catalog),/Unclassified operator recipient/);
});

test('custody deficits, nonconservation and malformed amounts fail before a proposal is usable',()=>{
  const {run,custody,catalog}=example();
  assert.throws(()=>proposedRetirementTokens(run,{...custody,baseRaw:'199'},catalog),/exceed/);
  assert.throws(()=>proposedRetirementTokens(run,{...custody,baseRaw:'205'},catalog),/classification/);
  for(const value of ['-1','1.5','01','18446744073709551616']) {
    const input=structuredClone(run);input.realizedOwnerTokens[0].baseRaw=value;
    assert.throws(()=>proposedRetirementTokens(input,custody,catalog),/accounting amount/);
  }
  run.tokenConservation[1].after='251';
  assert.throws(()=>proposedRetirementTokens(run,custody,catalog),/conservation/);
});
