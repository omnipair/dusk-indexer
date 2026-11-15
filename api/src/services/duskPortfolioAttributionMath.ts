import { BorshCoder } from '@coral-xyz/anchor';
import { SystemProgram } from '@solana/web3.js';
import { loadPinnedProtocol } from '../config/duskProtocol';
import { duskRawIdl } from './duskMarketSimulation';
import { formatUsd,indexedPortfolioDebt,nativeFields,nativeKey,usdUnits } from './duskPortfolioMath';
import type { PortfolioCaptureSource } from './duskPortfolioSnapshots';
import type { PortfolioIncomeProjection } from './duskPortfolioIncome';
import { unsigned } from './duskYieldAccounting';

export interface AccruedPortfolioInterest {position:string;market:string;mint:string;decimals:number;amount:string}
export interface AttributionPayment {eventKey:string;market:string;mint:string;decimals?:number;kind:'yield'|'interest';swap:string;interest:string}
export interface AttributionPrice {market:string;mint:string;decimals:number;priceUsd:string}
export interface AttributionBoundary {
  income:PortfolioIncomeProjection|null;interest:AccruedPortfolioInterest[]|null;
}

/** Principal repayment never enters interest expense. The exact debt-share
 * conversion is the same one used to value this original portfolio capture. */
export function accruedPortfolioInterest(source:PortfolioCaptureSource,owner:string):AccruedPortfolioInterest[] {
  const coder=new BorshCoder(duskRawIdl()),program=loadPinnedProtocol().dusk.programId,result:AccruedPortfolioInterest[]=[];
  const items=source.catalog.items.filter(item=>item.owner===owner&&['borrow','leverage'].includes(item.kind));
  for(const item of items){
    const groups=source.groups.filter(group=>group.market===item.market&&group.accounts.some(entry=>entry.address===item.address));
    if(groups.length!==1||groups[0].preview===null)throw new Error('Accrued interest has no complete captured bank');
    const group=groups[0],account=group.accounts.find(entry=>entry.address===item.address)!.account;
    if(!account||account.owner===SystemProgram.programId.toBase58()&&!account.executable&&account.data==='')continue;
    if(account.owner!==program||account.executable)throw new Error('Accrued-interest account owner differs');
    const state=nativeFields(coder.accounts.decode(item.kind==='borrow'?'BorrowPosition':'LeveragePosition',Buffer.from(account.data,'base64')));
    const market=nativeFields(coder.accounts.decode('Market',Buffer.from(group.marketAccount.data,'base64'))),debt=nativeFields(market.debt);
    if(nativeKey(state.owner)!==owner||nativeKey(state.market)!==item.market)throw new Error('Accrued-interest position binding differs');
    for(const side of ['base','quote'] as const){
      if(item.kind==='leverage'&&Number(unsigned(state.debt_asset,1n))!==(side==='base'?0:1))continue;
      const shares=state[item.kind==='borrow'?`fixed_${side}_shares`:'debt_shares'];
      const principal=unsigned(state[item.kind==='borrow'?`fixed_${side}_principal`:'debt_principal']);
      const amount=indexedPortfolioDebt(shares,debt[`${side}_borrow_index_nad`]);
      if(amount<principal)throw new Error('Recorded position principal exceeds indexed debt');
      const asset=nativeFields(market[`${side}_side`]);
      result.push({position:item.address,market:item.market,mint:nativeKey(asset.asset_mint),decimals:Number(unsigned(asset.asset_decimals,255n)),amount:(amount-principal).toString()});
    }
  }
  return result;
}

/** Net quantities earned/charged in the window, marked at its recorded end
 * prices. Repricing old unpaid balances is excluded; closed holdings and paid
 * claims remain in the totals. Paid interest cannot count twice as accrual. */
export function foldPortfolioAttribution(input:{start:AttributionBoundary;end:AttributionBoundary;payments:AttributionPayment[];prices:AttributionPrice[]}) {
  const amounts=new Map<string,{market:string;mint:string;decimals:number;swap:bigint;income:bigint;cost:bigint}>();
  const get=(market:string,mint:string,decimals?:number)=>{
    const key=`${market}:${mint}`,price=input.prices.find(price=>price.market===market&&price.mint===mint);
    const precision=decimals??price?.decimals;
    if(precision===undefined||!Number.isInteger(precision)||precision<0||precision>255||price&&price.decimals!==precision)
      throw new Error('Attribution asset precision is unavailable or inconsistent');
    let row=amounts.get(key);
    if(!row){row={market,mint,decimals:precision,swap:0n,income:0n,cost:0n};amounts.set(key,row);}
    if(row.decimals!==precision)throw new Error('Attribution asset precision changed');
    return row;
  };
  const incomeAvailable=input.start.income!==null&&input.end.income!==null
    &&input.start.income.unavailable.length===0&&input.end.income.unavailable.length===0;
  const costAvailable=input.start.interest!==null&&input.end.interest!==null;
  for(const [boundary,sign] of [[input.start,-1n],[input.end,1n]] as const){
    if(incomeAvailable)for(const stream of boundary.income!.streams){const row=get(stream.market,stream.assetMint,stream.assetDecimals);
      row.swap+=sign*unsigned(stream.swapFeeAmount);row.income+=sign*unsigned(stream.interestAmount);}
    if(costAvailable)for(const interest of boundary.interest!){get(interest.market,interest.mint,interest.decimals).cost+=sign*unsigned(interest.amount);}
  }
  const seen=new Set<string>();
  for(const payment of input.payments){
    if(seen.has(payment.eventKey))throw new Error('Duplicate canonical attribution payment');seen.add(payment.eventKey);
    if(payment.kind==='yield'&&!incomeAvailable||payment.kind==='interest'&&!costAvailable)continue;
    const row=get(payment.market,payment.mint,payment.decimals);
    if(payment.kind==='yield'&&incomeAvailable){row.swap+=unsigned(payment.swap);row.income+=unsigned(payment.interest);}
    else if(payment.kind==='interest'&&costAvailable)row.cost+=unsigned(payment.interest);
  }
  let swap=0n,income=0n,cost=0n,incomePriced=true,costPriced=true;
  const assets=[...amounts.values()].map(row=>{
    const price=input.prices.find(price=>price.market===row.market&&price.mint===row.mint);
    if(!price){if(row.swap!==0n||row.income!==0n)incomePriced=false;if(row.cost!==0n)costPriced=false;}
    if(price&&usdUnits(price.priceUsd)<=0n)throw new Error('Invalid attribution end price');
    const value=(amount:bigint)=>price?amount*usdUnits(price.priceUsd)/10n**BigInt(row.decimals):0n;
    const s=value(row.swap),i=value(row.income),c=value(row.cost);swap+=s;income+=i;cost+=c;
    return {market:row.market,mint:row.mint,decimals:row.decimals,swapFeeAmount:row.swap.toString(),interestEarnedAmount:row.income.toString(),
      borrowingCostAmount:row.cost.toString(),priceUsd:price?.priceUsd??null,swapFeeUsd:price?formatUsd(s):null,interestEarnedUsd:price?formatUsd(i):null,borrowingCostUsd:price?formatUsd(c):null};
  });
  return {earnedUsd:incomeAvailable&&incomePriced?formatUsd(swap+income):null,swapFeeUsd:incomeAvailable&&incomePriced?formatUsd(swap):null,
    interestEarnedUsd:incomeAvailable&&incomePriced?formatUsd(income):null,borrowingCostUsd:costAvailable&&costPriced?formatUsd(cost):null,assets};
}
