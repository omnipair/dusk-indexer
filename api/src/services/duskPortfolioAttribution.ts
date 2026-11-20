import { BorshCoder } from '@coral-xyz/anchor';
import type { PoolClient } from 'pg';
import pool from '../config/database';
import { canonicalJson,loadPinnedProtocol,sha256 } from '../config/duskProtocol';
import { duskRawIdl } from './duskMarketSimulation';
import { assertNoPortfolioConflict,verifyStoredPortfolioCapture } from './duskPortfolioSnapshots';
import type { PortfolioCaptureSource } from './duskPortfolioSnapshots';
import { formatUsd,portfolioDisplayPrices,usdUnits,nativeKey } from './duskPortfolioMath';
import { zeroIncomeSource,readPortfolioIncomeItems } from './duskPortfolioIncome';
import type { PortfolioIncomeProjection } from './duskPortfolioIncome';
import { accruedPortfolioInterest,foldPortfolioAttribution } from './duskPortfolioAttributionMath';
import type { AttributionBoundary,AttributionPayment,AttributionPrice } from './duskPortfolioAttributionMath';
import { historicalPriceAt,validateHistoricalPoint } from './duskHistoricalPriceMath';

export interface PortfolioAttributionQuery {owner:string;startCaptureId:string;endCaptureId:string}
const id=(value:string)=>/^[1-9]\d{0,18}$/.test(value);
const identity=()=>{const pin=loadPinnedProtocol();return [pin.cluster,pin.dusk.programId,pin.dusk.idlCanonicalSha256,pin.revision];};

async function readBoundary(client:PoolClient,owner:string,captureId:string){
  const result=await client.query(`SELECT o.*,c.valuations,c.components,i.income,i.content_hash AS income_hash,i.source_hash AS income_source_hash
    FROM dusk_ingestion.portfolio_capture_observations o
    JOIN dusk_ingestion.portfolio_effective_checkpoints c USING(capture_id)
    LEFT JOIN dusk_ingestion.portfolio_income_checkpoints i ON i.capture_id=c.capture_id AND i.owner=c.owner
    WHERE o.cluster=$1 AND o.program_id=$2 AND o.idl_hash=$3 AND o.protocol_revision=$4 AND c.owner=$5 AND o.capture_id=$6`,[...identity(),owner,captureId]);
  const row=result.rows[0];
  if(!row)throw Object.assign(new Error('Portfolio attribution capture is unavailable for this owner'),{status:404});
  verifyStoredPortfolioCapture(row);
  if(row.valuations.includesWalletBalances!==false||row.valuations.includesUnclaimedYield!==false)
    throw new Error('FINALIZED_INVARIANT: portfolio attribution net-value scope differs');
  const source=row.source as PortfolioCaptureSource;
  let income:PortfolioIncomeProjection|null=null;
  if(row.income){
    if(row.income_source_hash!==row.content_hash||sha256(canonicalJson([captureId,owner,row.content_hash,row.income]))!==row.income_hash)
      throw new Error('FINALIZED_INVARIANT: recorded portfolio income hash differs');
    income=row.income as PortfolioIncomeProjection;
  }else if(zeroIncomeSource(source))income={streams:[],unavailable:[]};
  let interest:AttributionBoundary['interest']=null;
  try{interest=accruedPortfolioInterest(source,owner);}catch{/* The value history remains usable when interest cannot be established. */}
  return {row,source,income,interest};
}
type Boundary=Awaited<ReturnType<typeof readBoundary>>;
function cutoff(boundary:Boundary,payload:Record<string,any>,kind:'yield'|'interest'){
  const matching=kind==='yield'?boundary.income?.streams.find(stream=>stream.holder===payload.owner&&stream.market===payload.market
    &&stream.lpMint===payload.lp_mint&&stream.assetMint===payload.asset_mint):undefined;
  if(matching)return Number(matching.sourceSlot);
  const position=kind==='interest'?boundary.source.catalog.items.find(item=>item.address===payload.position):undefined;
  const groups=boundary.source.groups.filter(group=>group.market===payload.market&&(!position||group.accounts.some(entry=>entry.address===position.address)));
  // A market created later has no prior liability at the start boundary.
  return groups.length?Math.min(...groups.map(group=>group.slot)):Number(boundary.row.source_min_slot);
}

async function endPrices(client:PoolClient,end:Boundary):Promise<{prices:AttributionPrice[];decimals:Map<string,number>}>{
  const pin=loadPinnedProtocol(),coder=new BorshCoder(duskRawIdl()),result:AttributionPrice[]=[];
  const decimalsByMint=new Map<string,number>();
  const groups=[...new Set(end.source.groups.map(group=>group.market))].map(market=>end.source.groups.filter(group=>group.market===market).sort((a,b)=>b.slot-a.slot)[0]);
  for(const group of groups){
    const market=coder.accounts.decode('Market',Buffer.from(group.marketAccount.data,'base64'));
    const preview=group.preview===null?null:coder.types.decode('MarketPreview',Buffer.from(group.preview,'base64'));
    const prices=portfolioDisplayPrices({pin,marketAddress:group.market,market,preview,slot:group.slot,blockTime:group.blockTime,
      references:end.source.references,displayPriceObservations:group.displayPriceObservations,deploymentIdentitySha256:group.deploymentIdentitySha256})??[];
    const points=await client.query(`SELECT point_id::text,mint,source_time,fetched_at,price_usd::text,evidence,content_hash
      FROM dusk_ingestion.historical_price_points WHERE cluster=$1 AND program_id=$2 AND idl_hash=$3 AND protocol_revision=$4
        AND source_time<=$5 AND source_time>$5::timestamptz-interval '1 minute'`,[...identity(),group.blockTime]);
    const historical=points.rows.map(row=>validateHistoricalPoint({pointId:row.point_id,mint:row.mint,sourceTime:row.source_time.toISOString(),
      fetchedAt:row.fetched_at.toISOString(),priceUsd:row.price_usd,evidence:row.evidence,contentHash:row.content_hash}));
    const raw=market as Record<string,any>;
    for(const side of ['base','quote']){
      const mint=nativeKey(raw[`${side}_side`].asset_mint),decimals=Number(raw[`${side}_side`].asset_decimals);
      decimalsByMint.set(`${group.market}:${mint}`,decimals);
      const price=prices.find(price=>price.mint===mint),late=historicalPriceAt(historical,mint,group.blockTime);
      if(price||late)result.push({market:group.market,mint,decimals,priceUsd:price?.priceUsd??late!.priceUsd});
    }
  }
  return {prices:result,decimals:decimalsByMint};
}

/** Caller owns one repeatable-read transaction. Only saved sources and canonical
 * payments enter this endpoint; it never prices old amounts from a live read. */
export async function readPortfolioAttribution(client:PoolClient,options:PortfolioAttributionQuery){
  const owner=nativeKey(options.owner);
  if(!id(options.startCaptureId)||!id(options.endCaptureId))throw Object.assign(new Error('Invalid portfolio attribution captures'),{status:400});
  await assertNoPortfolioConflict(client);
  const start=await readBoundary(client,owner,options.startCaptureId),end=options.startCaptureId===options.endCaptureId?start:await readBoundary(client,owner,options.endCaptureId);
  if(new Date(start.row.capture_time)>new Date(end.row.capture_time)||Number(start.row.source_max_slot)>Number(end.row.source_max_slot))
    throw Object.assign(new Error('Portfolio attribution start follows its end'),{status:400});
  const positions=await client.query<{position:string}>(`SELECT position FROM dusk_ingestion.streamed_borrow_positions
    WHERE cluster=$1 AND program_id=$2 AND idl_hash=$3 AND protocol_revision=$4 AND owner=$5
    UNION SELECT position FROM dusk_ingestion.streamed_leverage_positions
    WHERE cluster=$1 AND program_id=$2 AND idl_hash=$3 AND protocol_revision=$4 AND owner=$5`,[...identity(),owner]);
  const holders=[...new Set([owner,...(await readPortfolioIncomeItems(client,owner)).map(item=>item.holder)])];
  const rows=await client.query<{event_key:string;event_name:string;slot:string;payload:Record<string,any>}>(`
    SELECT event_key,event_name,slot::text,payload FROM dusk_ingestion.streamed_events
    WHERE cluster=$1 AND program_id=$2 AND idl_hash=$3 AND protocol_revision=$4 AND slot BETWEEN $5 AND $6
      AND ((event_name='YieldClaimed' AND payload->>'owner'=ANY($7::text[]))
        OR (event_name='BorrowInterestPaid' AND payload->>'position'=ANY($8::text[]))) LIMIT 10001`,
    [...identity(),start.row.source_min_slot,end.row.source_max_slot,holders,positions.rows.map(row=>row.position)]);
  if(rows.rows.length>10000)throw Object.assign(new Error('Portfolio attribution window exceeds the bounded payment history'),{status:422});
  const payments:AttributionPayment[]=[],pricing=await endPrices(client,end);
  for(const row of rows.rows){
    const p=row.payload,kind=row.event_name==='YieldClaimed'?'yield':'interest',slot=Number(row.slot);
    if(slot>cutoff(start,p,kind)&&slot<=cutoff(end,p,kind))payments.push({eventKey:row.event_key,market:p.market,mint:p.asset_mint,kind,
      decimals:pricing.decimals.get(`${p.market}:${p.asset_mint}`),swap:kind==='yield'?p.swap_fee_amount:'0',interest:kind==='yield'?p.interest_amount:p.interest_paid});
  }
  const calculated=foldPortfolioAttribution({start,end,payments,prices:pricing.prices});
  const first=start.row.valuations.netPositionValueUsd,last=end.row.valuations.netPositionValueUsd;
  const change=first!==null&&last!==null?formatUsd(usdUnits(last)-usdUnits(first)):null;
  const rest=change!==null&&calculated.earnedUsd!==null&&calculated.borrowingCostUsd!==null
    ?formatUsd(usdUnits(change)-usdUnits(calculated.earnedUsd)+usdUnits(calculated.borrowingCostUsd)):null;
  return {schemaVersion:'dusk-portfolio-attribution.v1' as const,owner,
    window:{startCaptureId:options.startCaptureId,endCaptureId:options.endCaptureId,since:new Date(start.row.capture_time).toISOString(),until:new Date(end.row.capture_time).toISOString()},
    totals:{changeUsd:change,...calculated,remainingUsd:rest},
    coverage:{basis:'paid-plus-change-in-claimable-and-accrued.v1',priceBasis:'recorded-end-of-period',includesWalletBalances:false,
      netValueBasis:'positions-excluding-wallet-and-unclaimed-yield.v1',
      includesCompoundedYield:false,sourceSlot:Number(end.row.source_max_slot),
      incomeAvailable:calculated.earnedUsd!==null,borrowingCostAvailable:calculated.borrowingCostUsd!==null,
      startSourceHash:start.row.content_hash,endSourceHash:end.row.content_hash,paymentKeys:payments.map(payment=>sha256(payment.eventKey)).sort()}};
}
export async function listPortfolioAttribution(options:PortfolioAttributionQuery){
  const client=await pool.connect();
  try{await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');const result=await readPortfolioAttribution(client,options);await client.query('COMMIT');return result;}
  catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
