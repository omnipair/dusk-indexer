import { retirementMinimumNetPayout, RETIREMENT_CLOSURE_POLICY } from './duskRetirementPolicy';

const natural=(value:unknown):bigint=>{
  if(typeof value!=='string'||!/^(0|[1-9][0-9]*)$/.test(value))throw new Error('Invalid retirement accounting amount');
  const amount=BigInt(value);
  if(amount>(1n<<64n)-1n)throw new Error('Retirement accounting amount exceeds u64');
  return amount;
};

export interface RetirementProposalCatalog {
  owners: string[];
  yieldAccounts: string[];
  receiptMints: string[];
  assetMints: [string,string];
  lockedSeniorShares: string;
}

function sameCatalog(actual:string[],expected:string[]):boolean {
  return new Set(actual).size===actual.length && new Set(expected).size===expected.length
    && actual.length===expected.length && expected.every(value=>actual.includes(value));
}

/** This produces a proposal for human review, never a signing authorization.
 * The native report must have exhausted every economic claim before residual
 * capital/income is classified for the fixed treasury. */
export function proposedRetirementTokens(run:any,custody:{baseRaw:string;quoteRaw:string},catalog:RetirementProposalCatalog) {
  if(!run.allLeverageClosed || run.steps.some((step:any)=>/rejected$/.test(step.status)))throw new Error('Retirement rehearsal is incomplete');
  if(catalog.owners.length===0 || catalog.receiptMints.length!==4 || new Set(catalog.assetMints).size!==2)
    throw new Error('Invalid retirement source catalog');
  if(!sameCatalog(run.finalReceiptSupplies.map((row:any)=>row.mint),catalog.receiptMints))
    throw new Error('Retirement receipt catalog differs');
  if(!sameCatalog(run.tokenConservation.map((row:any)=>row.mint),catalog.assetMints)
    || run.tokenConservation.some((row:any)=>natural(row.before)!==natural(row.after)))
    throw new Error('Retirement token conservation differs');
  const market=run.finalMarket;
  if(!catalog.owners.includes(market.operator.revenueRecipient))throw new Error('Unclassified operator recipient');
  const debtKeys=['fixedBaseShares','fixedQuoteShares','fixedBasePrincipal','fixedQuotePrincipal',
    'isolatedBaseShares','isolatedQuoteShares','isolatedBasePrincipal','isolatedQuotePrincipal'];
  if(!sameCatalog(Object.keys(run.remainingDebt),debtKeys))throw new Error('Retirement debt catalog differs');
  if(Object.values(run.remainingDebt).some(value=>natural(value)!==0n))throw new Error('Retirement debt remains');
  for(const vault of [market.baseHlpVault,market.quoteHlpVault])
    if(['hlpSupply','debtShares','debtPrincipal','residualExposure','flashCollateralDebit'].some(key=>natural(vault[key])!==0n))
      throw new Error('Retirement hLP funding remains');
  if(run.finalReceiptSupplies.some((row:any)=>natural(row.supply)!==0n))throw new Error('Circulating retirement receipts remain');
  if(natural(market.tranches.queuedReceipts)!==0n || natural(market.tranches.juniorReceiptSupply)!==natural(market.tranches.permanentReceipts)
    || natural(market.baseSide.shares.srlpSupply)!==natural(market.tranches.juniorReserveShares)+natural(catalog.lockedSeniorShares))
    throw new Error('Unsettled junior or senior capital remains');
  if([market.income.books,market.income.pending,market.income.revenue].some(rows=>rows.length!==4))
    throw new Error('Retirement income books are incomplete');
  if(market.income.books.some((book:any)=>natural(book.unpaid)!==0n) || market.income.pending.some((value:any)=>natural(value)!==0n))
    throw new Error('Unpaid income books remain');
  for(const book of market.income.revenue)
    if(['grossUnpaid','protocolUnpaid','operatorUnpaid','pendingGross','pendingProtocolGross','operatorClaimable'].some(key=>natural(book[key])!==0n))
      throw new Error('Unpaid operator or protocol revenue remains');
  const yields=run.finalEconomicAccounts.filter((row:any)=>row.kind==='YieldAccount');
  if(!sameCatalog(yields.map((row:any)=>row.address),catalog.yieldAccounts))throw new Error('Retirement income catalog differs');
  if(yields.some((row:any)=>!catalog.owners.includes(row.state.recipient)))throw new Error('Unclassified income recipient');
  if(yields.some((row:any)=>natural(row.state.accrued_swap_fee_amount)!==0n || natural(row.state.accrued_interest_amount)!==0n))
    throw new Error('Unpaid holder cash remains');
  const finalChecks=run.steps.filter((row:any)=>row.pass==='after-junior');
  if(!sameCatalog(finalChecks.map((row:any)=>row.yieldAccount),catalog.yieldAccounts)
    || finalChecks.some((row:any)=>row.status!=='income-no-current-payout-locally'))throw new Error('Final income claim replay is incomplete');
  const owners=run.realizedOwnerTokens.map((row:any)=>row.owner);
  if(!sameCatalog(owners,catalog.owners))throw new Error('Retirement beneficiary catalog differs');
  const users=run.realizedOwnerTokens.map((row:any)=>{
    const base=natural(row.baseRaw),quote=natural(row.quoteRaw);
    return {owner:row.owner,baseRaw:String(base),quoteRaw:String(quote),
      minimumBaseRaw:String(retirementMinimumNetPayout(base)),minimumQuoteRaw:String(retirementMinimumNetPayout(quote))};
  });
  const treasury:any={owner:RETIREMENT_CLOSURE_POLICY.residualRecipient};
  const allocation:any={};
  for(const side of ['base','quote'] as const) {
    const budget=natural(custody[`${side}Raw`]),paid=users.reduce((sum:bigint,row:any)=>sum+natural(row[`${side}Raw`]),0n);
    if(paid>budget)throw new Error('Retirement payouts exceed actual market custody');
    const remaining=budget-paid,fees=market[`${side}Side`].fees;
    if(natural(fees.referralInterestLiability)!==0n || natural(fees.revenueInterestLiability)!==0n
      || natural(fees.unallocatedSwapFeeLiability)!==0n || natural(fees.unallocatedInterestLiability)!==0n)
      throw new Error('Unresolved referral, revenue or unallocated claim remains');
    const protocol=['swapProtocolFeeLiability','interestProtocolFeeLiability','swapBuybackFeeLiability','interestBuybackFeeLiability']
      .reduce((sum,key)=>sum+natural(fees[key]),0n);
    const seedIncome=natural(fees.junior.seedSwapAmount)+natural(fees.junior.seedInterestAmount);
    const permanentIncomeAndRounding=natural(fees.swapFeeLiability)+natural(fees.interestLiability)-seedIncome;
    const permanentCapital=remaining-protocol-seedIncome-permanentIncomeAndRounding;
    if(permanentIncomeAndRounding<0n || permanentCapital<0n)throw new Error('Retirement residual classification does not conserve');
    treasury[`${side}Raw`]=String(remaining);
    allocation[side]={sourceCustodyRaw:String(budget),usersRaw:String(paid),protocolFeesRaw:String(protocol),
      permanentSeedIncomeRaw:String(seedIncome),permanentIncomeAndRoundingRaw:String(permanentIncomeAndRounding),
      permanentCapitalRaw:String(permanentCapital),treasuryRaw:String(remaining)};
  }
  return {status:'proposed-not-authorized-for-execution',executionReady:false,policy:RETIREMENT_CLOSURE_POLICY,
    strategy:run.strategy,users,treasury,allocation,
    limitations:['actual freeze and retirement program implementation still required',
      'finalized frozen recapture and review of amounts still required','SOL rent and delegate-order cleanup are separate from token entitlements']};
}
