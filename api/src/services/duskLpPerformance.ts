/** Recorded srLP capital basis. Current token prices never enter this ledger. */
import type { PoolClient } from 'pg';
import pool from '../config/database';
import { loadPinnedProtocol } from '../config/duskProtocol';
import { readEventHistory } from './duskEventHistory';
import { marketCreationCovers, readHistoryScan } from './duskHistoryCoverage';
import { formatUsd, usdUnits } from './duskPortfolioMath';
import type { EventHistoricalPrices } from './duskEventHistoryPrices';
import type { DuskDeploymentEnvelope } from './duskDeploymentService';
import type { StreamedLpBalance } from './duskHlpPositions';

interface Asset { mint: string; decimals: number }
interface CapitalEvent {
  eventKey: string; eventName: string; market: unknown; signature: string; slot: string;
  instructionPath: number[]; eventOrdinal: number; time: string; payload: Record<string,unknown>;
  historicalPrices?: EventHistoricalPrices;
}
const raw = (value: unknown): bigint => {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,19})$/.test(value) || BigInt(value) >= 1n<<64n)
    throw new Error('Invalid LP capital amount');
  return BigInt(value);
};
function valueAt(event: CapitalEvent,legs: { asset: Asset; amount: bigint }[]): bigint | null {
  let total = 0n;
  for (const { asset,amount } of legs) {
    if (amount === 0n) continue;
    const evidence = event.historicalPrices;
    const price = evidence?.prices.find(p => p.mint === asset.mint && p.decimals === asset.decimals);
    if (!price || evidence?.asOf !== event.time || ![event.time,price.observedAt,price.sourceTime].every(t=>Number.isFinite(Date.parse(t)))
      || Date.parse(price.observedAt)>Date.parse(event.time)
      || Date.parse(price.sourceTime)>Date.parse(price.observedAt)) return null;
    const usd = usdUnits(price.priceUsd);
    if (usd<=0n) return null;
    total += amount*usd/10n**BigInt(asset.decimals);
  }
  return total;
}
function pathOrder(a: CapitalEvent,b: CapitalEvent) {
  for (let i=0;i<Math.min(a.instructionPath.length,b.instructionPath.length);i++)
    if (a.instructionPath[i]!==b.instructionPath[i]) return a.instructionPath[i]-b.instructionPath[i];
  return a.instructionPath.length-b.instructionPath.length || a.eventOrdinal-b.eventOrdinal;
}

/** Moving-average basis for still-held shares; withdrawals realize their own
 * share of basis. External transfers/conversions need an acquisition basis and
 * deliberately remain unknown. Same-slot transaction order is never guessed. */
export function foldLpCapital(input: {
  owner: string; market: string; lpMint: string; balance: string;
  base: Asset; quote: Asset; complete: boolean; changedOwnership: boolean; events: CapitalEvent[];
}) {
  let shares=0n,basis=0n,contributed=0n,withdrawn=0n,realized=0n,claimed=0n,claimedSwap=0n,claimedInterest=0n;
  let basisKnown=input.complete&&!input.changedOwnership,claimsKnown=input.complete;
  const seen = new Set<string>();
  const events = input.events.filter(e => ['LiquidityAdded','LiquidityRemoved','YieldClaimed'].includes(e.eventName))
    .sort((a,b) => Number(a.slot)-Number(b.slot) || pathOrder(a,b));
  const capital = events.filter(e => e.eventName==='LiquidityAdded' || e.eventName==='LiquidityRemoved');
  for (const e of capital) {
    const sameSlot = capital.filter(other => other.slot===e.slot);
    if (sameSlot.some(other => other.signature!==e.signature && other.eventName!==e.eventName)) basisKnown=false;
  }
  try {
    for (const event of events) {
      const p=event.payload;
      if (seen.has(event.eventKey) || event.market!==input.market || p.market!==input.market || p.owner!==input.owner)
        throw new Error('LP capital identity differs');
      seen.add(event.eventKey);
      if (event.eventName==='YieldClaimed') {
        if (p.token_kind!=='0' || p.lp_mint!==input.lpMint) continue;
        const asset = [input.base,input.quote].find(a => a.mint===p.asset_mint);
        if (!asset) throw new Error('Yield asset differs');
        if(raw(p.recipient_credit)>raw(p.swap_fee_amount)+raw(p.interest_amount)) throw new Error('Yield credit exceeds earned income');
        const value=valueAt(event,[{asset,amount:raw(p.recipient_credit)}]);
        const swap=valueAt(event,[{asset,amount:raw(p.swap_fee_amount)}]);
        const interest=valueAt(event,[{asset,amount:raw(p.interest_amount)}]);
        if (value===null || swap===null || interest===null) claimsKnown=false;
        else { claimed+=value;claimedSwap+=swap;claimedInterest+=interest; }
        continue;
      }
      if (event.eventName!=='LiquidityAdded' && event.eventName!=='LiquidityRemoved') continue;
      const added=event.eventName==='LiquidityAdded',amount=raw(p.srlp_amount);
      const value=valueAt(event,[
        {asset:input.base,amount:raw(p[added?'base_reserve_credit':'base_owner_credit'])},
        {asset:input.quote,amount:raw(p[added?'quote_reserve_credit':'quote_owner_credit'])},
      ]);
      if (amount===0n || !added && amount>shares) basisKnown=false;
      if (value===null) basisKnown=false;
      if (added) { shares+=amount; basis+=value??0n; contributed+=value??0n; }
      else {
        const removed=shares>0n ? basis*amount/shares : 0n;
        basis-=removed; shares-=amount; withdrawn+=value??0n; realized+=(value??0n)-removed;
      }
    }
    if (shares!==raw(input.balance) || shares<0n || basis<0n) basisKnown=false;
  } catch { basisKnown=false; claimsKnown=false; }
  return {market:input.market,lpMint:input.lpMint,balance:input.balance,
    basis:'moving-average-recorded-srlp-capital.v1' as const,
    remainingBasisUsd:basisKnown?formatUsd(basis):null,
    contributedUsd:basisKnown?formatUsd(contributed):null,
    withdrawnUsd:basisKnown?formatUsd(withdrawn):null,
    realizedCapitalPnlUsd:basisKnown?formatUsd(realized):null,
    claimedYieldUsd:claimsKnown?formatUsd(claimed):null,
    claimedSwapFeeUsd:claimsKnown?formatUsd(claimedSwap):null,
    claimedInterestUsd:claimsKnown?formatUsd(claimedInterest):null};
}

export async function readLpPerformance(owner: string,balances: StreamedLpBalance[],deployment: DuskDeploymentEnvelope,supplied?: PoolClient) {
  const held=balances.filter(b => b.kind==='srlp');
  if (!held.length || held.length>64) return [];
  const client: PoolClient=supplied??await pool.connect();
  // History is auxiliary to holdings and exits. Destroying this read-only
  // connection bounds the entire pass, including a long sequence of queries.
  let released=false;
  const deadline=supplied?undefined:setTimeout(()=>{released=true;client.release(true);},2000);
  try {
    if(!supplied) await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const pin=loadPinnedProtocol(),active=[pin.cluster,pin.dusk.programId,pin.dusk.idlCanonicalSha256,pin.revision];
    const scan=await readHistoryScan(client);
    if (!scan || Date.now()-Date.parse(scan.throughBlockTime)>30000) throw new Error('LP history is stale');
    const until=new Date(Math.min(Date.parse(scan.throughBlockTime)-1,Date.parse(deployment.observedAt))).toISOString();
    const catalog=await client.query<{market:string;srlp_mint:string;base_mint:string;quote_mint:string;base_decimals:number;quote_decimals:number;created_slot:string;created_at:Date}>(`
      SELECT market,srlp_mint,base_mint,quote_mint,base_decimals,quote_decimals,created_slot::text,created_at
      FROM dusk_ingestion.streamed_markets WHERE cluster=$1 AND program_id=$2 AND idl_hash=$3 AND protocol_revision=$4
        AND market=ANY($5::text[])`,[...active,held.map(b=>b.market)]);
    const result=[];
    for (const balance of held) {
      const meta=catalog.rows.find(m=>m.market===balance.market && m.srlp_mint===balance.lpMint);
      if (!meta) throw new Error('LP history market binding differs');
      const history=await readEventHistory(client,{owner,market:balance.market,category:'activity',version:2,until,limit:500,
        deployment,deploymentIdentitySha256:deployment.deploymentIdentitySha256});
      // Any ownership transfer or tranche conversion makes the simple srLP
      // acquisition ledger insufficient. It must never manufacture a basis.
      const moved=await client.query(`SELECT 1 FROM dusk_ingestion.canonical_events c
        JOIN dusk_ingestion.event_observations o USING(cluster,program_id,idl_hash,protocol_revision,event_key,observation_id)
        WHERE c.cluster=$1 AND c.program_id=$2 AND c.idl_hash=$3 AND c.protocol_revision=$4
          AND c.commitment IN ('confirmed','finalized') AND o.commitment=c.commitment
          AND o.decoded_payload->>'market'=$5 AND (
            (o.event_name='LpTransferred' AND o.decoded_payload->>'lp_mint'=$6
              AND (o.decoded_payload->>'source_owner'=$7 OR o.decoded_payload->>'destination_owner'=$7))
            OR (o.event_name='TrancheConverted' AND o.decoded_payload->>'owner'=$7)) LIMIT 1`,
        [...active,balance.market,balance.lpMint,owner]);
      const complete=!history.pagination.hasMore && marketCreationCovers(scan,{createdAt:meta.created_at.toISOString(),createdSlot:meta.created_slot},until);
      const row=foldLpCapital({owner,market:balance.market,lpMint:balance.lpMint,balance:balance.amount,
        base:{mint:meta.base_mint,decimals:meta.base_decimals},quote:{mint:meta.quote_mint,decimals:meta.quote_decimals},
        complete,changedOwnership:Boolean(moved.rowCount),events:history.events});
      result.push({...row,sourceSlot:Number(scan.throughSlot),throughTime:until});
    }
    if(!supplied) await client.query('COMMIT');
    return result;
  } catch(error) {if(!supplied&&!released) await client.query('ROLLBACK');throw error;}
  finally {clearTimeout(deadline);if(!supplied&&!released) client.release();}
}
