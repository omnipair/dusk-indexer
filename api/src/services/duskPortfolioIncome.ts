/** Replayable funded LP income from the same finalized banks as portfolio value. */
import { BorshCoder } from '@coral-xyz/anchor';
import { Connection,PublicKey,SystemProgram } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID,unpackAccount,getAssociatedTokenAddressSync } from '@solana/spl-token';
import type { PoolClient } from 'pg';
import { deriveIncomeEpochAddress,deriveYieldAccountAddress,incomeArchiveRequests } from '@omnipair/dusk-sdk';
import type { IncomeArchiveMap,IncomeBookInput } from '@omnipair/dusk-sdk';
import { duskApiConfig,loadPinnedProtocol } from '../config/duskProtocol';
import { duskRawIdl } from './duskMarketSimulation';
import { marketLayoutVersion } from './duskProtocolSchema';
import type { MarketSimulationSnapshot,SnapshotAccount } from './duskMarketSimulation';
import { nativeFields,nativeKey } from './duskPortfolioMath';
import { projectLiveYield,unsigned } from './duskYieldAccounting';

export interface PortfolioIncomeItem {
  address: string; holder: string; owner: string; market: string; lpMint: string;
  kind: 'srlp'|'hlp'|'junior'; baseMint: string; quoteMint: string;
}
export interface PortfolioIncomeStream {
  owner: string; holder: string; market: string; lpMint: string; assetMint: string;
  assetDecimals: number; swapFeeAmount: string; interestAmount: string;
  sourceSlot: string; sourceTime: string;
}
export interface PortfolioIncomeEvidence {
  items: PortfolioIncomeItem[];
  accounts: MarketSimulationSnapshot['accounts'];
  archives: MarketSimulationSnapshot['accounts'];
  archivesUnavailable?: boolean;
}

/** Include zero holdings and settled escrows: their earned rights can outlive shares. */
export async function readPortfolioIncomeItems(client:PoolClient,owner?:string):Promise<PortfolioIncomeItem[]> {
  const pin=loadPinnedProtocol(),active=[pin.cluster,pin.dusk.programId,pin.dusk.idlCanonicalSha256,pin.revision];
  const rows=await client.query<{holder:string;owner:string;market:string;lp_mint:string;kind:string;base_mint:string;quote_mint:string}>(`
    WITH escrows AS (
      SELECT DISTINCT order_address,owner_address,market_address,payload->'accounts'->'named'->>'target_hlp_mint' AS lp_mint
      FROM dusk_ingestion.order_instruction_observations
      WHERE cluster=$1 AND program_id=$5 AND idl_hash=$6 AND protocol_revision=$4 AND instruction_name='create_hlp_order'
    ), holdings AS (
      SELECT b.owner AS holder,coalesce(e.owner_address,b.owner) AS owner,b.market,b.lp_mint,b.kind
      FROM dusk_ingestion.streamed_lp_balances b LEFT JOIN escrows e ON e.order_address=b.owner AND e.market_address=b.market AND e.lp_mint=b.lp_mint
      WHERE b.cluster=$1 AND b.program_id=$2 AND b.idl_hash=$3 AND b.protocol_revision=$4
      UNION SELECT order_address,owner_address,market_address,lp_mint,'hlp' FROM escrows
    )
    SELECT h.*,m.base_mint,m.quote_mint FROM holdings h JOIN dusk_ingestion.streamed_markets m ON m.market=h.market
      AND m.cluster=$1 AND m.program_id=$2 AND m.idl_hash=$3 AND m.protocol_revision=$4
    WHERE ($7::text IS NULL OR h.owner=$7)
    ORDER BY h.market,h.holder,h.lp_mint LIMIT 100001`,[...active,pin.leverageDelegate.programId,pin.leverageDelegate.idlCanonicalSha256,owner??null]);
  if(rows.rows.length>100000)throw new Error('Portfolio income catalog exceeds the bounded capture');
  const result=new Map<string,PortfolioIncomeItem>();
  for(const row of rows.rows){
    const item:PortfolioIncomeItem={address:getAssociatedTokenAddressSync(new PublicKey(row.lp_mint),new PublicKey(row.holder),true,TOKEN_2022_PROGRAM_ID).toBase58(),
      holder:nativeKey(row.holder),owner:nativeKey(row.owner),market:nativeKey(row.market),lpMint:nativeKey(row.lp_mint),
      kind:row.kind==='srlp'?'srlp':row.kind==='junior'?'junior':'hlp',baseMint:nativeKey(row.base_mint),quoteMint:nativeKey(row.quote_mint)};
    const previous=result.get(item.address);
    if(previous&&JSON.stringify(previous)!==JSON.stringify(item))throw new Error('Portfolio income ownership conflicts');
    result.set(item.address,item);
  }
  return [...result.values()];
}
export interface PortfolioIncomeProjection {
  streams: PortfolioIncomeStream[];
  unavailable: { owner: string; market: string; lpMint: string; reason: string }[];
}

/** Borsh's original IDL names and the SDK's camelCase describe the same bytes. */
export function incomeCamel(value: any): any {
  if (Array.isArray(value)) return value.map(incomeCamel);
  if (!value || typeof value!=='object' || value instanceof PublicKey || typeof value.toArrayLike==='function') return value;
  return Object.fromEntries(Object.entries(value).map(([key,entry])=>[
    key.replace(/_([a-z])/g,(_match,letter:string)=>letter.toUpperCase()),incomeCamel(entry)]));
}
function accountBytes(account: SnapshotAccount | null | undefined,owner: string): Buffer | null {
  if (!account || account.owner===SystemProgram.programId.toBase58() && !account.executable && account.data==='') return null;
  const bytes=Buffer.from(account.data,'base64');
  if(account.owner!==owner||account.executable||!bytes.length||bytes.toString('base64')!==account.data)
    throw new Error('Invalid recorded income account');
  return bytes;
}
export function incomeAddresses(item: PortfolioIncomeItem): string[] {
  const program=new PublicKey(loadPinnedProtocol().dusk.programId);
  return [item.address,...[item.baseMint,item.quoteMint].map(mint=>deriveYieldAccountAddress(
    new PublicKey(item.market),new PublicKey(item.holder),new PublicKey(item.lpMint),new PublicKey(mint),item.kind,program)[0].toBase58())];
}
function decodedIncome(group: MarketSimulationSnapshot,evidence: PortfolioIncomeEvidence,item: PortfolioIncomeItem) {
  const pin=loadPinnedProtocol(),coder=new BorshCoder(duskRawIdl());
  const market=incomeCamel(coder.accounts.decode('Market',accountBytes(group.marketAccount,pin.dusk.programId)!));
  if(Number(market.version)!==marketLayoutVersion()||item.market!==group.market||nativeKey(market.baseSide.assetMint)!==item.baseMint||nativeKey(market.quoteSide.assetMint)!==item.quoteMint)
    throw new Error('Recorded income market binding differs');
  if(item.kind==='srlp'&&nativeKey(market.srlpMint)!==item.lpMint)throw new Error('Recorded srLP mint differs');
  const expected=incomeAddresses(item);
  const entries=expected.map(address=>{
    const matches=[...group.accounts,...evidence.accounts].filter(entry=>entry.address===address);
    if(matches.length!==1)throw new Error('Recorded income source is incomplete or duplicated');
    return matches[0].account;
  });
  const tokenBytes=accountBytes(entries[0],TOKEN_2022_PROGRAM_ID.toBase58());
  const token=tokenBytes?unpackAccount(new PublicKey(item.address),{owner:TOKEN_2022_PROGRAM_ID,executable:false,data:tokenBytes,lamports:0},TOKEN_2022_PROGRAM_ID):null;
  if(token&&(!token.isInitialized||token.owner.toBase58()!==item.holder||token.mint.toBase58()!==item.lpMint))throw new Error('Recorded income holding differs');
  const accounts=entries.slice(1).map((entry,index)=>{
    const bytes=accountBytes(entry,pin.dusk.programId);
    const account=bytes?incomeCamel(coder.accounts.decode('YieldAccount',bytes)):null;
    const [,bump]=deriveYieldAccountAddress(new PublicKey(item.market),new PublicKey(item.holder),new PublicKey(item.lpMint),
      new PublicKey([item.baseMint,item.quoteMint][index]),item.kind,new PublicKey(pin.dusk.programId));
    if(account&&(nativeKey(account.owner)!==item.holder||nativeKey(account.market)!==item.market
      ||nativeKey(account.lpMint)!==item.lpMint||nativeKey(account.assetMint)!==[item.baseMint,item.quoteMint][index]
      ||Number(account.tokenKind)!=={srlp:0,hlp:1,junior:2}[item.kind]||Number(account.bump)!==bump
      ||nativeKey(account.recipient)===PublicKey.default.toBase58()))throw new Error('Recorded yield account binding differs');
    return account;
  });
  return {market,accounts,balance:token?.amount??0n,coder};
}

/** Only immutable, already-ended income epochs can come from a later bank. */
export async function capturePortfolioIncomeArchives(group: MarketSimulationSnapshot,evidence: PortfolioIncomeEvidence,
  read?: (addresses:string[],slot:number)=>Promise<MarketSimulationSnapshot['accounts']>) {
  const program=new PublicKey(loadPinnedProtocol().dusk.programId),requests=new Set<string>();
  for(const item of evidence.items){
    const {market,accounts}=decodedIncome(group,evidence,item);
    accounts.forEach((account,asset)=>{
      if(!account)return;
      for(const request of incomeArchiveRequests(account,market.income.books,asset as 0|1))
        requests.add(deriveIncomeEpochAddress(new PublicKey(item.market),request.bookIndex,request.epoch,program)[0].toBase58());
    });
  }
  if(requests.size>256)throw new Error('Recorded income archives exceed the bounded capture');
  if(!requests.size)return [];
  if(read)return read([...requests],group.slot);
  const rpc=new Connection(duskApiConfig().rpcUrl,'finalized'),result:MarketSimulationSnapshot['accounts']=[];
  const addresses=[...requests];
  for(let offset=0;offset<addresses.length;offset+=100){
    const batch=addresses.slice(offset,offset+100),response=await rpc.getMultipleAccountsInfoAndContext(batch.map(address=>new PublicKey(address)),{commitment:'finalized',minContextSlot:group.slot});
    if(response.context.slot<group.slot||response.value.length!==batch.length)throw new Error('Income archives are stale');
    result.push(...batch.map((address,index)=>({address,account:response.value[index]?{
      owner:response.value[index]!.owner.toBase58(),executable:response.value[index]!.executable,data:response.value[index]!.data.toString('base64')}:null})));
  }
  return result;
}

export function projectPortfolioIncome(group: MarketSimulationSnapshot,evidence: PortfolioIncomeEvidence,
  cohorts: MarketSimulationSnapshot['accounts'] = []): PortfolioIncomeProjection {
  const streams:PortfolioIncomeStream[]=[],unavailable:PortfolioIncomeProjection['unavailable']=[];
  const program=new PublicKey(loadPinnedProtocol().dusk.programId);
  for(const item of evidence.items){
    if(group.preview===null){unavailable.push({owner:item.owner,market:item.market,lpMint:item.lpMint,reason:'market-preview-unavailable'});continue;}
    const {market,accounts,balance,coder}=decodedIncome(group,evidence,item);
    let cohort:any;
    const retired=item.kind==='junior'?!market.juniorMint.equals(new PublicKey(item.lpMint))
      :item.kind==='hlp'&&!market.baseSide.hlpMint.equals(new PublicKey(item.lpMint))&&!market.quoteSide.hlpMint.equals(new PublicKey(item.lpMint));
    if(retired){
      const seed=item.kind==='junior'?'junior_cohort':'hlp_cohort';
      const [address,bump]=PublicKey.findProgramAddressSync([Buffer.from(seed),new PublicKey(item.market).toBuffer(),new PublicKey(item.lpMint).toBuffer()],program);
      const entry=cohorts.find(entry=>entry.address===address.toBase58());
      cohort=incomeCamel(coder.accounts.decode(item.kind==='junior'?'JuniorCohort':'HlpCohort',accountBytes(entry?.account,program.toBase58())!));
      if(nativeKey(cohort.market)!==item.market||nativeKey(cohort.mint)!==item.lpMint||!cohort.retired||Number(cohort.bump)!==bump)
        throw new Error('Recorded income cohort differs');
    }
    if(evidence.archivesUnavailable){unavailable.push({owner:item.owner,market:item.market,lpMint:item.lpMint,reason:'income-archives-unavailable'});continue;}
    for(const [asset,account] of accounts.entries()){
      let amounts={swapFeeAmount:0n,interestAmount:0n};
      if(account){
        const archives=new Map<string,IncomeBookInput>();
        for(const request of incomeArchiveRequests(account,market.income.books,asset as 0|1)){
          const [address,bump]=deriveIncomeEpochAddress(new PublicKey(item.market),request.bookIndex,request.epoch,program);
          const matching=evidence.archives.filter(entry=>entry.address===address.toBase58());
          if(matching.length!==1)throw new Error('Missing immutable income epoch');
          const archive=incomeCamel(coder.accounts.decode('IncomeEpoch',accountBytes(matching[0].account,program.toBase58())!));
          if(nativeKey(archive.market)!==item.market||Number(archive.bookIndex)!==request.bookIndex||Number(archive.bump)!==bump
            ||String(archive.book.epoch)!==String(request.epoch))throw new Error('Income archive PDA differs');
          archives.set(`${request.bookIndex}:${request.epoch}`,archive.book);
        }
        const retiredLedger=cohort?(item.kind==='junior'?cohort.finalIncome[asset]:cohort.finalVault):undefined,ends=cohort?.incomeEnd;
        amounts=projectLiveYield(market,account,balance,retiredLedger,{archives:archives as IncomeArchiveMap,ends});
      }
      streams.push({owner:item.owner,holder:item.holder,market:item.market,lpMint:item.lpMint,assetMint:[item.baseMint,item.quoteMint][asset],
        assetDecimals:Number([market.baseSide,market.quoteSide][asset].assetDecimals),swapFeeAmount:amounts.swapFeeAmount.toString(),
        interestAmount:amounts.interestAmount.toString(),sourceSlot:String(group.slot),sourceTime:group.blockTime});
    }
  }
  return {streams,unavailable};
}

/** A legacy capture with no growth anywhere proves an actual zero anchor. */
export function zeroIncomeSource(source:{groups:MarketSimulationSnapshot[]}) {
  const coder=new BorshCoder(duskRawIdl());
  return source.groups.length>0&&source.groups.every(group=>{
    if(group.preview===null)return false;
    const market=nativeFields(coder.accounts.decode('Market',Buffer.from(group.marketAccount.data,'base64')));
    for(const side of ['base','quote']){
      const fees=nativeFields(nativeFields(market[`${side}_side`]).fees);
      for(const field of ['swap_fee_growth_index_q64','interest_growth_index_q64','unallocated_swap_fee_liability','unallocated_interest_liability'])
        if(unsigned(fees[field])!==0n)return false;
      const junior=nativeFields(fees.junior);
      if(unsigned(junior.swap_growth_q64)!==0n||unsigned(junior.interest_growth_q64)!==0n)return false;
    }
    const books=nativeFields(market.income).books;
    return Array.isArray(books)&&books.length===4&&books.every(book=>{
      const value=nativeFields(book);
      return ['epoch','unpaid','units','paid_per_unit_q64'].every(key=>unsigned(value[key])===0n)
        &&Array.isArray(value.growth)&&value.growth.every(growth=>{
          const entry=nativeFields(growth);
          return unsigned(entry.units_q64)===0n&&Array.isArray(entry.weighted_paid_q128)&&entry.weighted_paid_q128.length===4
            &&entry.weighted_paid_q128.every(limb=>unsigned(limb)===0n);
        });
    });
  });
}
