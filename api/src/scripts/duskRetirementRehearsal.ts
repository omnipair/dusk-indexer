/** Capture one finalized bank and rehearse existing owner close semantics in
 * LiteSVM only. No signatures, mainnet transactions or forced authority bypass. */
import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { AnchorProvider, BorshCoder, Idl, BN } from '@coral-xyz/anchor';
import { Connection, PublicKey, SYSVAR_CLOCK_PUBKEY, SYSVAR_RENT_PUBKEY,
  SystemProgram, ComputeBudgetProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { createInitializeAccount3Instruction, createTransferCheckedInstruction, createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, getAccountLenForMint, unpackMint } from '@solana/spl-token';
import { address, lamports, getTransactionDecoder } from '@solana/kit';
import { FailedTransactionMetadata, LiteSVM } from 'litesvm';
import type { Dusk } from '@omnipair/dusk-sdk';
import { loadProtocolAt, canonicalJson, sha256 } from '../config/duskProtocol';
import { createFrozenProgramRuntime } from '../services/duskFrozenProgramRuntime';
import type { FrozenLeverageBank } from '../services/duskLeverageMaximumInput';
import { LEGACY_RETIREMENT, retirementObservationHash, reconcileRetirementReceipts } from '../services/duskRetirementInventory';
import { RETIREMENT_CLOSURE_POLICY, retirementMinimumNetPayout } from '../services/duskRetirementPolicy';
import { parseRetirementRpcJson, assertRetirementFrozenBank, assertRetirementWalletObservation } from '../services/duskRetirementBank';
import { proposedRetirementTokens } from '../services/duskRetirementManifest';

const UPGRADEABLE = 'BPFLoaderUpgradeab1e11111111111111111111111';
interface RawAccount { owner:string; executable:boolean; lamports:number; rentEpoch:string; data:[string,string] }
interface RpcBank { context:{slot:number}; value:(RawAccount|null)[] }
function unpack(raw:RawAccount) {
  if (raw.data[1] !== 'base64') throw new Error('Invalid bank encoding');
  return {...raw,owner:new PublicKey(raw.owner),data:Buffer.from(raw.data[0],'base64')};
}
function jsonState(value:any):any {
  if(BN.isBN(value))return value.toString(10);
  if(value instanceof PublicKey)return value.toBase58();
  if(Array.isArray(value))return value.map(jsonState);
  if(value && typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,value])=>[key,jsonState(value)]));
  return value;
}
function connectionFor(svm:LiteSVM,bank:FrozenLeverageBank):Connection {
  const info = (key:PublicKey) => {
    const row = svm.getAccount(address(key.toBase58()));
    return row.exists ? {owner:new PublicKey(row.programAddress),data:Buffer.from(row.data),
      executable:row.executable,lamports:Number(row.lamports),rentEpoch:0} : null;
  };
  return {
    commitment:'finalized',
    async getAccountInfo(key:PublicKey) { return info(key); },
    async getAccountInfoAndContext(key:PublicKey) { return {context:{slot:bank.slot},value:info(key)}; },
    async getMultipleAccountsInfo(keys:PublicKey[]) { return keys.map(info); },
    async getMultipleAccountsInfoAndContext(keys:PublicKey[]) { return {context:{slot:bank.slot},value:keys.map(info)}; },
    async getMinimumBalanceForRentExemption(size:number) { return Number(svm.minimumBalanceForRentExemption(BigInt(size))); },
    async getEpochInfo() { const clock=svm.getClock();return {epoch:Number(clock.epoch),absoluteSlot:bank.slot}; },
    async getSlot() { return bank.slot; },
  } as unknown as Connection;
}

async function main() {
  if (![4,6].includes(process.argv.length) || process.argv.length===6 && process.argv[4]!=='--bank')
    throw new Error('Expected INVENTORY_JSON NEW_OUTPUT_JSON [--bank PREVIOUS_REHEARSAL_JSON]');
  const inventory = JSON.parse(readFileSync(resolve(process.argv[2]),'utf8'));
  const {contentSha256,...durable} = inventory;
  if (retirementObservationHash(durable) !== contentSha256 || inventory.schemaVersion !== 'dusk-legacy-retirement-inventory.v1'
    || inventory.summary.market !== LEGACY_RETIREMENT.market) throw new Error('Invalid retirement inventory artifact');
  const root=resolve(__dirname,'../../../protocol'),pin=loadProtocolAt(root);
  if (pin.revision !== LEGACY_RETIREMENT.revision || pin.cluster !== 'mainnet-beta'
    || canonicalJson(inventory.identity.dusk)!==canonicalJson(pin.dusk)
    || canonicalJson(inventory.identity.delegate)!==canonicalJson(pin.leverageDelegate)) throw new Error('Retirement pin changed');
  const endpoint=process.env.DUSK_RPC_URL || 'https://api.mainnet-beta.solana.com';
  const reference=process.argv.length===6?JSON.parse(readFileSync(resolve(process.argv[5]),'utf8')):undefined;
  if(reference) {
    const {contentSha256:hash,...body}=reference;
    if(reference.schemaVersion!=='dusk-legacy-close-rehearsal.v1' || reference.inventorySha256!==contentSha256
      || retirementObservationHash(body)!==hash || retirementObservationHash(reference.bank)!==reference.bankSha256)
      throw new Error('Invalid offline retirement reference');
  }
  async function read<T>(method:'getGenesisHash'|'getMultipleAccounts'|'getProgramAccounts',params:unknown[]=[]):Promise<T> {
    if(reference)throw new Error('Offline rehearsal attempted an RPC request');
    for(let attempt=0;attempt<4;attempt++) {
      const response=await fetch(endpoint,{method:'POST',signal:AbortSignal.timeout(30_000),headers:{'Content-Type':'application/json'},
        body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})}).catch(()=>{throw new Error('Read-only bank transport failed');});
      if(response.status===429 && attempt<3){await new Promise(done=>setTimeout(done,1000*(attempt+1)));continue;}
      if(!response.ok)throw new Error('Read-only bank capture failed');
      let body:{error?:unknown;result:T};
      try { body=parseRetirementRpcJson(await response.text()) as {error?:unknown;result:T}; }
      catch { throw new Error('Invalid read-only bank response'); }
      if(body.error)throw new Error('Read-only bank capture rejected');
      return body.result;
    }
    throw new Error('Read-only bank rate limit');
  }
  if(!reference && await read<string>('getGenesisHash')!==pin.genesisHash)throw new Error('Wrong bank genesis');
  for(const previous of reference?[]:inventory.programs) {
    const catalog=await read<{context:{slot:number};value:{pubkey:string}[]}>('getProgramAccounts',[previous.program,
      {commitment:'finalized',withContext:true,encoding:'base64'}]);
    if(canonicalJson(catalog.value.map(row=>row.pubkey).sort())!==canonicalJson(previous.value.map((row:any)=>row.pubkey).sort()))
      throw new Error('Program account catalog changed; capture a fresh inventory');
  }
  // IDL/hook metadata and current cohort/delegation records are not read by
  // these owner exits (LPs are burned, never transferred). Keep every retired
  // cohort and every economic account; the separate inventory retains all bytes.
  const unused=new Set<string>([
    ...inventory.ancillary.filter((row:any)=>row.kind!=='unclassified').map((row:any)=>row.address),
    ...inventory.decoded.filter((row:any)=>['HlpCohort','JuniorCohort'].includes(row.kind) && row.state.retired===false).map((row:any)=>row.address),
  ]);
  const keys=new Set<string>([
    SYSVAR_CLOCK_PUBKEY.toBase58(),SYSVAR_RENT_PUBKEY.toBase58(),
    'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA','TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
    'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
    pin.dusk.programId,pin.dusk.deployment.programData,pin.leverageDelegate.programId,pin.leverageDelegate.deployment.programData,
    pin.dusk.deployment.upgradeAuthority!,...inventory.summary.owners,
    ...inventory.programs.flatMap((program:any)=>program.value.filter((row:any)=>!unused.has(row.pubkey)).map((row:any)=>row.pubkey)),
    ...inventory.mints.addresses,...inventory.tokenBanks.flatMap((row:any)=>row.bank.value.map((a:any)=>a.pubkey)),
    ...inventory.custody.flatMap((row:any)=>row.bank.value.map((a:any)=>a.pubkey)),
  ]);
  for(const row of inventory.decoded.filter((row:any)=>row.kind==='YieldAccount')) {
    keys.add(getAssociatedTokenAddressSync(new PublicKey(row.state.lp_mint),new PublicKey(row.state.owner),true,TOKEN_2022_PROGRAM_ID).toBase58());
    keys.add(getAssociatedTokenAddressSync(new PublicKey(row.state.asset_mint),new PublicKey(row.state.recipient),true).toBase58());
  }
  // Discover CPI program-data pointers before the single atomic capture.
  const cpiKeys=['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA','TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb','ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'];
  const fromReference=(selection:string[]):RpcBank=>({context:{slot:reference.bank.slot},value:selection.map(key=>{
    const row=reference.bank.accounts.find((row:any)=>row.address===key);
    if(!row)throw new Error('Offline reference omits a required account');
    return row.account?{...row.account,data:[row.account.data,'base64']}:null;
  })});
  const cpis=reference?fromReference(cpiKeys):await read<RpcBank>('getMultipleAccounts',[cpiKeys,{commitment:'finalized',encoding:'base64'}]);
  for(const raw of cpis.value)if(raw?.owner===UPGRADEABLE){const b=unpack(raw).data;
    if(b.length!==36 || b.readUInt32LE(0)!==2)throw new Error('Invalid CPI program');keys.add(new PublicKey(b.subarray(4)).toBase58());}
  const wallets=[...new Set<string>([pin.dusk.deployment.upgradeAuthority!,...inventory.summary.owners])].sort();
  // Only plain system-wallet SOL can move to a separate observation. Never
  // split token balances, claim accounts, mints, sysvars or executable state.
  const separateWallets=!!reference?.walletObservation||keys.size>100;
  if(separateWallets)for(const wallet of wallets)keys.delete(wallet);
  const addresses=[...keys].sort();
  if(addresses.length>100)throw new Error('One-off bank exceeds single-RPC account limit');
  const captured=reference?fromReference(addresses):await read<RpcBank>('getMultipleAccounts',[addresses,{commitment:'finalized',encoding:'base64',minContextSlot:inventory.slotRange.through}]);
  if(captured.value.length!==addresses.length || !Number.isSafeInteger(captured.context.slot)
    || captured.context.slot<inventory.slotRange.through)throw new Error('Invalid finalized bank');
  const bank:FrozenLeverageBank={slot:captured.context.slot,accounts:captured.value.map((raw,index)=>({address:addresses[index],
    account:raw?{...raw,data:raw.data[0],rentEpoch:String(raw.rentEpoch)}:null}))};
  assertRetirementFrozenBank(bank,pin);
  let walletObservation:FrozenLeverageBank|undefined;
  if(separateWallets){
    if(reference)walletObservation=reference.walletObservation;
    else {
      const capturedWallets=await read<RpcBank>('getMultipleAccounts',[wallets,{commitment:'finalized',encoding:'base64',minContextSlot:bank.slot}]);
      if(capturedWallets.value.length!==wallets.length)throw new Error('Incomplete wallet observation');
      walletObservation={slot:capturedWallets.context.slot,accounts:capturedWallets.value.map((raw,index)=>({address:wallets[index],
        account:raw?{...raw,data:raw.data[0],rentEpoch:String(raw.rentEpoch)}:null}))};
    }
    if(!walletObservation)throw new Error('Missing offline wallet observation');
    assertRetirementWalletObservation(walletObservation,bank,wallets);
  }
  reconcileRetirementReceipts(inventory.summary.receipts.map((receipt:any)=>{
    const mint=bank.accounts.find(row=>row.address===receipt.mint)?.account;if(!mint)throw new Error('Missing receipt mint');
    return {mint:receipt.mint,supply:Buffer.from(mint.data,'base64').readBigUInt64LE(36).toString(),accounts:
      inventory.tokenBanks.find((row:any)=>row.mint===receipt.mint).bank.value.flatMap((old:any)=>{
        const row=bank.accounts.find(row=>row.address===old.pubkey)?.account;if(!row)return [];
        const data=Buffer.from(row.data,'base64');return [{address:old.pubkey,owner:new PublicKey(data.subarray(32,64)).toBase58(),
          amount:data.readBigUInt64LE(64).toString(),frozen:data[108]===2}];
      })};
  }));
  const code=bank.accounts.find(row=>row.address===pin.dusk.deployment.programData)?.account;
  if(!code || code.owner!==UPGRADEABLE)throw new Error('Missing pinned program');
  const bytes=Buffer.from(code.data,'base64');
  if(bytes.readUInt32LE(0)!==3 || bytes.readBigUInt64LE(4)!==BigInt(pin.dusk.deployment.deploySlot)
    || bytes.length!==pin.dusk.deployment.allocatedBinaryBytes+45 || sha256(bytes.subarray(45))!==pin.dusk.binarySha256)
    throw new Error('Retirement executable changed');
  const idl=JSON.parse(readFileSync(resolve(root,'idl/dusk.json'),'utf8')) as Idl,coder=new BorshCoder(idl);
  const positions=bank.accounts.flatMap(row=>{
    if(!row.account || row.account.owner!==pin.dusk.programId)return [];
    const raw=Buffer.from(row.account.data,'base64'),tag=idl.accounts!.find(a=>a.name==='LeveragePosition')!.discriminator;
    if(!raw.subarray(0,8).equals(Buffer.from(tag)))return [];
    const state=coder.accounts.decode('LeveragePosition',raw) as any;
    if(state.market.toBase58()!==LEGACY_RETIREMENT.market)throw new Error('Position crossed retirement market');
    return [{address:row.address,state}];
  });
  const sdk=await import('@omnipair/dusk-sdk');
  if(sha256(canonicalJson(sdk.IDL))!==pin.dusk.idlCanonicalSha256)throw new Error('Rehearsal SDK differs from pin');
  const longFirst=[...positions].sort((a,b)=>b.state.debt_asset-a.state.debt_asset || a.address.localeCompare(b.address));
  const variants=[
    {label:'address-order',order:[...positions].sort((a,b)=>a.address.localeCompare(b.address)),loans:false,convert:false,convertBaseOnly:false},
    {label:'longs-first',order:longFirst,loans:false,convert:false,convertBaseOnly:false},
    {label:'longs-loans-retain-collateral-short',order:longFirst,loans:true,convert:false,convertBaseOnly:false},
    {label:'longs-loans-convert-collateral-short',order:longFirst,loans:true,convert:true,convertBaseOnly:false},
    {label:'longs-loans-convert-base-retain-quote-short',order:longFirst,loans:true,convert:false,convertBaseOnly:true},
  ];
  const runs=[];
  for(const variant of variants) {
    const order=variant.order;
    const svm=createFrozenProgramRuntime(bank,pin.dusk.programId,bytes.subarray(45));
    for(const row of walletObservation?.accounts??[]){
      const account=row.account;if(!account)continue;
      svm.setAccount({address:address(row.address),programAddress:address(account.owner),lamports:lamports(BigInt(account.lamports)),
        data:Buffer.alloc(0),executable:false,space:0n});
    }
    const connection=connectionFor(svm,bank),payer=new PublicKey(pin.dusk.deployment.upgradeAuthority!);
    const provider=new AnchorProvider(connection,{publicKey:payer,signTransaction:async()=>{throw new Error('Rehearsal never signs');},
      signAllTransactions:async()=>{throw new Error('Rehearsal never signs');}},{commitment:'finalized'});
    const dusk:Dusk=new sdk.Dusk({provider,programId:new PublicKey(pin.dusk.programId)});
    const steps:any[]=[];
    const payouts:{owner:string;mint:string;account:PublicKey}[]=[];
    function localTransaction(instructions:any[]) {
      const tx=new VersionedTransaction(new TransactionMessage({payerKey:payer,recentBlockhash:svm.latestBlockhash(),instructions:[
        ComputeBudgetProgram.requestHeapFrame({bytes:256*1024}),ComputeBudgetProgram.setComputeUnitLimit({units:1_400_000}),...instructions,
      ]}).compileToV0Message());
      if(tx.serialize().length>1232)throw new Error('Local retirement transaction exceeds packet limit');
      return tx;
    }
    async function executeLocal(instructions:any[]) {
      const tx=localTransaction(instructions);
      const result=svm.sendTransaction(getTransactionDecoder().decode(tx.serialize()));
      if(result instanceof FailedTransactionMetadata)throw Object.assign(new Error('Local retirement operation rejected'),{logs:result.meta().logs(),detail:result.err().toString()});
      return result;
    }
    function tokenBalance(key:PublicKey) { const row=svm.getAccount(address(key.toBase58()));return row.exists?Buffer.from(row.data).readBigUInt64LE(64):0n; }
    async function unwindLoans() {
      const tag=idl.accounts!.find(row=>row.name==='BorrowPosition')!.discriminator;
      const loans=bank.accounts.filter(row=>row.account?.owner===pin.dusk.programId
        && Buffer.from(row.account.data,'base64').subarray(0,8).equals(Buffer.from(tag))).sort((a,b)=>b.address.localeCompare(a.address));
      for(let index=0;index<loans.length;index++) {
        const row=loans[index],state=coder.accounts.decode('BorrowPosition',Buffer.from(row.account!.data,'base64')) as any;
        const market=await dusk.get.market(LEGACY_RETIREMENT.market);
        const baseRaw=await connection.getAccountInfo(market.baseSide.assetMint),quoteRaw=await connection.getAccountInfo(market.quoteSide.assetMint);
        if(!baseRaw||!quoteRaw)throw new Error('Missing loan mint');
        const base=await PublicKey.createWithSeed(payer,`retire-loan-b${index}`,baseRaw.owner);
        const quote=await PublicKey.createWithSeed(payer,`retire-loan-q${index}`,quoteRaw.owner);
        const setup=[];
        for(const [key,mintKey,raw,seed] of [[base,market.baseSide.assetMint,baseRaw,`retire-loan-b${index}`],
          [quote,market.quoteSide.assetMint,quoteRaw,`retire-loan-q${index}`]] as const) {
          const mint=unpackMint(mintKey,raw,raw.owner),space=getAccountLenForMint(mint);
          setup.push(SystemProgram.createAccountWithSeed({fromPubkey:payer,basePubkey:payer,seed,newAccountPubkey:key,
            lamports:Number(svm.minimumBalanceForRentExemption(BigInt(space))),space,programId:raw.owner}),
          createInitializeAccount3Instruction(key,mintKey,state.owner,raw.owner));
        }
        await executeLocal(setup);
        const quoteDebt=BigInt(state.fixed_quote_shares.toString())>0n;
        if(quoteDebt && BigInt(state.fixed_base_shares.toString())>0n)throw new Error('Dual-debt loan requires an explicit strategy');
        const collateralMint=quoteDebt?market.baseSide.assetMint:market.quoteSide.assetMint,debtMint=quoteDebt?market.quoteSide.assetMint:market.baseSide.assetMint;
        const collateralAccount=quoteDebt?base:quote,debtAccount=quoteDebt?quote:base;
        async function sellCollateral(amount:bigint) {
          const swap=await dusk.write.buildSwapInstruction({market:state.market,trader:state.owner,
            assetInMint:collateralMint,assetOutMint:debtMint,traderAssetInAccount:collateralAccount,traderAssetOutAccount:debtAccount,
            exactAssetIn:amount,minAssetOut:0n});
          await executeLocal([swap]);
        }
        // Reuse only this same owner's already-realized protocol proceeds. No
        // treasury balance, outside wallet funds or synthetic token credits.
        const direct=payouts.filter(payout=>payout.owner===state.owner.toBase58()&&payout.mint===debtMint.toBase58());
        for(const source of direct){
          const amount=tokenBalance(source.account);if(amount===0n)continue;
          const mintRaw=await connection.getAccountInfo(debtMint);if(!mintRaw)throw new Error('Missing realized debt mint');
          const mint=unpackMint(debtMint,mintRaw,mintRaw.owner);
          await executeLocal([createTransferCheckedInstruction(source.account,debtMint,debtAccount,state.owner,amount,mint.decimals,[],mintRaw.owner)]);
          steps.push({status:'same-owner-debt-proceeds-reused-locally',owner:state.owner.toBase58(),loan:row.address,
            mint:debtMint.toBase58(),amountRaw:String(amount),sourceAccount:source.account.toBase58()});
        }
        if(tokenBalance(debtAccount)>0n)await executeLocal([await dusk.write.repayInstruction({market:state.market,owner:state.owner,
          positionOwner:state.owner,positionId:state.position_id,borrowPosition:row.address,debtAssetMint:debtMint,
          collateralAssetMint:collateralMint,ownerDebtAccount:debtAccount,repayAmount:tokenBalance(debtAccount)})]);
        if(!quoteDebt) {
          const sources=payouts.filter(payout=>payout.owner===state.owner.toBase58() && payout.mint===collateralMint.toBase58());
          for(const source of sources) {
            const amount=tokenBalance(source.account);
            if(amount===0n)continue;
            const mintRaw=await connection.getAccountInfo(collateralMint);
            if(!mintRaw)throw new Error('Missing proceeds mint');
            const mint=unpackMint(collateralMint,mintRaw,mintRaw.owner);
            await executeLocal([createTransferCheckedInstruction(source.account,collateralMint,collateralAccount,state.owner,amount,mint.decimals,[],mintRaw.owner)]);
            steps.push({status:'same-owner-proceeds-reused-locally',owner:state.owner.toBase58(),loan:row.address,
              mint:collateralMint.toBase58(),amountRaw:amount.toString(),sourceAccount:source.account.toBase58()});
          }
          if(tokenBalance(collateralAccount)>0n) {
            await sellCollateral(tokenBalance(collateralAccount));
            await executeLocal([await dusk.write.repayInstruction({market:state.market,owner:state.owner,positionOwner:state.owner,
              positionId:state.position_id,borrowPosition:row.address,debtAssetMint:debtMint,collateralAssetMint:collateralMint,
              ownerDebtAccount:debtAccount,repayAmount:tokenBalance(debtAccount)})]);
          }
        }
        const collateral=BigInt((quoteDebt?state.base_collateral:state.quote_collateral).toString());
        // This bounded legacy-case proposal uses prior same-owner proceeds
        // before the base loan, avoiding an unnecessary sale of extra META.
        const first=collateral*(quoteDebt?44n:35n)/100n;
        const withdraw=await dusk.write.withdrawCollateralInstruction({market:state.market,owner:state.owner,positionId:state.position_id,
          borrowPosition:row.address,assetMint:collateralMint,ownerAssetAccount:collateralAccount,withdrawAmount:first,
          minAssetAmountOut:first,minLiquidationCfBps:0});
        await executeLocal([withdraw]);
        await sellCollateral(first);
        const repay=await dusk.write.repayInstruction({market:state.market,owner:state.owner,positionOwner:state.owner,
          positionId:state.position_id,borrowPosition:row.address,debtAssetMint:debtMint,collateralAssetMint:collateralMint,
          ownerDebtAccount:debtAccount,repayAmount:tokenBalance(debtAccount)});
        await executeLocal([repay]);
        const withdrawAll=await dusk.write.withdrawAllCollateralInstruction({market:state.market,owner:state.owner,
          positionId:state.position_id,borrowPosition:row.address,baseMint:market.baseSide.assetMint,quoteMint:market.quoteSide.assetMint,
          ownerBaseAccount:base,ownerQuoteAccount:quote,minBaseOut:0n,minQuoteOut:0n});
        await executeLocal([withdrawAll]);
        const convertRest=variant.convert || variant.convertBaseOnly && quoteDebt;
        if(convertRest)await sellCollateral(tokenBalance(collateralAccount));
        steps.push({position:row.address,owner:state.owner.toBase58(),status:'loan-closed-locally',
          collateralConversion:convertRest?'full-collateral-sale':'partial-collateral-sale-and-same-owner-proceeds',
          baseNetRaw:tokenBalance(base).toString(),quoteNetRaw:tokenBalance(quote).toString(),
          minimumBaseNetRaw:retirementMinimumNetPayout(tokenBalance(base)).toString(),minimumQuoteNetRaw:retirementMinimumNetPayout(tokenBalance(quote)).toString(),
          note:'hypothetical owner-authorized ordinary actions; staged loan legs do not yet enforce a transaction-wide net bound'});
      }
    }
    let loansAttempted=false;
    for(let index=0;index<order.length;index++) {
      if(variant.loans && !loansAttempted && order[index].state.debt_asset===0) {
        loansAttempted=true;
        try { await unwindLoans(); }
        catch(error) { const e=error as {message?:string;logs?:string[];detail?:string};steps.push({status:'loan-rejected',error:e.message,detail:e.detail,logs:e.logs});break; }
      }
      const row=order[index],state=row.state,market=await dusk.get.market(LEGACY_RETIREMENT.market);
      const debt=state.debt_asset===0?market.baseSide:market.quoteSide,collateral=state.debt_asset===0?market.quoteSide:market.baseSide;
      const mintRaw=await connection.getAccountInfo(debt.assetMint);
      if(!mintRaw)throw new Error('Missing debt mint');
      const mint=unpackMint(debt.assetMint,mintRaw,mintRaw.owner),seed=`retire-close-${index}`;
      const recipient=await PublicKey.createWithSeed(payer,seed,mintRaw.owner),space=getAccountLenForMint(mint);
      async function transaction(minAmountOut:bigint) {
        const close=await dusk.write.closeLeverageInstruction({owner:state.owner,positionOwner:state.owner,
          market:state.market,positionId:state.position_id,namespaceAuthority:state.namespace_authority,leveragePosition:row.address,
          debtAsset:state.debt_asset===0?'base':'quote',debtMint:debt.assetMint,collateralMint:collateral.assetMint,
          ownerDebtAccount:recipient,minAmountOut,closeBps:10000});
        return new VersionedTransaction(new TransactionMessage({payerKey:payer,recentBlockhash:svm.latestBlockhash(),instructions:[
          ComputeBudgetProgram.requestHeapFrame({bytes:256*1024}),ComputeBudgetProgram.setComputeUnitLimit({units:1_400_000}),
          SystemProgram.createAccountWithSeed({fromPubkey:payer,basePubkey:payer,seed,newAccountPubkey:recipient,
            lamports:Number(svm.minimumBalanceForRentExemption(BigInt(space))),space,programId:mintRaw!.owner}),
          createInitializeAccount3Instruction(recipient,debt.assetMint,state.owner,mintRaw!.owner),close,
        ]}).compileToV0Message());
      }
      const quoteTx=await transaction(0n),quote=svm.simulateTransaction(getTransactionDecoder().decode(quoteTx.serialize()));
      if(quote instanceof FailedTransactionMetadata){steps.push({position:row.address,owner:state.owner.toBase58(),status:'rejected',
        error:quote.err().toString(),logs:quote.meta().logs(),computeUnits:String(quote.meta().computeUnitsConsumed())});break;}
      const receipt=quote.postAccounts().find(account=>account.address===recipient.toBase58());
      if(!receipt)throw new Error('Missing simulated owner payout');
      const net=Buffer.from(receipt.data).readBigUInt64LE(64),minimum=retirementMinimumNetPayout(net);
      const tx=await transaction(minimum),committed=svm.sendTransaction(getTransactionDecoder().decode(tx.serialize()));
      if(committed instanceof FailedTransactionMetadata)throw new Error('Local commit differs from quote');
      const output=svm.getAccount(address(recipient.toBase58()));
      if(!output.exists || Buffer.from(output.data).readBigUInt64LE(64)!==net)throw new Error('Local net receipt changed');
      steps.push({position:row.address,owner:state.owner.toBase58(),status:'closed-locally',debtMint:debt.assetMint.toBase58(),
        quotedNetRaw:net.toString(),minimumNetRaw:minimum.toString(),computeUnits:String(committed.computeUnitsConsumed()),
        unsignedTransaction:Buffer.from(tx.serialize()).toString('base64')});
      payouts.push({owner:state.owner.toBase58(),mint:debt.assetMint.toBase58(),account:recipient});
    }
    const allLeverageClosed=steps.filter(row=>row.status==='closed-locally').length===positions.length;
    if(allLeverageClosed && variant.convertBaseOnly) {
      try {
        let holderIndex=0;
        for(const side of ['base','quote'] as const) {
          const market=await dusk.get.market(LEGACY_RETIREMENT.market),target=side==='base'?market.baseSide:market.quoteSide;
          const borrowed=side==='base'?market.quoteSide:market.baseSide,vault=side==='base'?market.baseHlpVault:market.quoteHlpVault;
          const holders=inventory.summary.receipts.find((row:any)=>row.mint===target.hlpMint.toBase58()).accounts;
          for(const holder of holders) {
            const balance=tokenBalance(new PublicKey(holder.address));if(balance===0n)continue;
            const owner=new PublicKey(holder.owner),raw=await connection.getAccountInfo(target.assetMint);
            if(!raw)throw new Error('Missing hLP target mint');
            const mint=unpackMint(target.assetMint,raw,raw.owner),space=getAccountLenForMint(mint),seed=`retire-hlp-${holderIndex++}`;
            const recipient=await PublicKey.createWithSeed(payer,seed,raw.owner);
            const setup=[SystemProgram.createAccountWithSeed({fromPubkey:payer,basePubkey:payer,seed,newAccountPubkey:recipient,
              lamports:Number(svm.minimumBalanceForRentExemption(BigInt(space))),space,programId:raw.owner}),
              createInitializeAccount3Instruction(recipient,target.assetMint,owner,raw.owner)];
            async function build(minimum:bigint) {
              return dusk.write.withdrawSingleSided({hlpAmount:balance,minTargetAmountOut:minimum},{market:LEGACY_RETIREMENT.market,
                payer,owner,targetHlpMint:target.hlpMint,baseMint:market.baseSide.assetMint,quoteMint:market.quoteSide.assetMint,
                accounts:{futarchyAuthority:inventory.decoded.find((row:any)=>row.kind==='FutarchyAuthority').address,
                  srlpMint:market.srlpMint,baseReserveVault:market.baseSide.reserveVault,quoteReserveVault:market.quoteSide.reserveVault,
                  borrowedInterestVault:borrowed.interestVault,ownerTargetAccount:recipient,ownerHlpAccount:holder.address,
                  hlpSrlpAccount:vault.srlpVault,tokenProgram:'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
                  token2022Program:'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'}});
            }
            const quoteBuild=await build(0n),quoteTx=localTransaction([...setup,...quoteBuild.setupInstructions,quoteBuild.actionInstruction]);
            const quote=svm.simulateTransaction(getTransactionDecoder().decode(quoteTx.serialize()));
            if(quote instanceof FailedTransactionMetadata)throw Object.assign(new Error('hLP withdrawal rejected'),{detail:quote.err().toString(),logs:quote.meta().logs()});
            const receipt=quote.postAccounts().find(account=>account.address===recipient.toBase58());
            if(!receipt)throw new Error('Missing hLP net receipt');
            const net=Buffer.from(receipt.data).readBigUInt64LE(64),minimum=retirementMinimumNetPayout(net),built=await build(minimum);
            await executeLocal([...setup,...built.setupInstructions,built.actionInstruction]);
            if(tokenBalance(recipient)!==net || tokenBalance(new PublicKey(holder.address))!==0n)throw new Error('hLP exit differs from quote');
            payouts.push({owner:holder.owner,mint:target.assetMint.toBase58(),account:recipient});
            steps.push({status:'hlp-withdrawn-locally',owner:holder.owner,receiptAccount:holder.address,hlpAmount:balance.toString(),
              targetMint:target.assetMint.toBase58(),quotedNetRaw:net.toString(),minimumNetRaw:minimum.toString()});
          }
        }
      } catch(error) {const e=error as {message?:string;detail?:string;logs?:string[]};steps.push({status:'hlp-rejected',error:e.message,detail:e.detail,logs:e.logs});}
      async function withdrawSeniorHolder(holder:{owner:string;address:string},index:number,phase='sr') {
        const market=await dusk.get.market(LEGACY_RETIREMENT.market);
            const owner=new PublicKey(holder.owner),amount=tokenBalance(new PublicKey(holder.address));
            if(amount===0n)return;
            let caughtUp=false;
            for(let pass=0;pass<16;pass++) {
              const prepared=await dusk.tranches.prepareHolderIncome({market:LEGACY_RETIREMENT.market,owner,kind:'senior'});
              for(const tx of prepared.transactions)await executeLocal(tx.instructions);
              if(!prepared.hasMore){caughtUp=true;break;}
            }
            if(!caughtUp)throw new Error('Senior income catch-up exceeded one-off bound');
            const destinations:PublicKey[]=[],setup=[];
            for(const [asset,side] of [['b',market.baseSide],['q',market.quoteSide]] as const) {
              const raw=await connection.getAccountInfo(side.assetMint);if(!raw)throw new Error('Missing senior asset mint');
              const mint=unpackMint(side.assetMint,raw,raw.owner),space=getAccountLenForMint(mint),seed=`retire-${phase}-${asset}${index}`;
              const destination=await PublicKey.createWithSeed(payer,seed,raw.owner);destinations.push(destination);
              setup.push(SystemProgram.createAccountWithSeed({fromPubkey:payer,basePubkey:payer,seed,newAccountPubkey:destination,
                lamports:Number(svm.minimumBalanceForRentExemption(BigInt(space))),space,programId:raw.owner}),
                createInitializeAccount3Instruction(destination,side.assetMint,owner,raw.owner));
            }
            // Setup is committed only inside this disposable VM; the final
            // payout accounts are empty and owned by the actual LP holder.
            await executeLocal(setup);
            async function removal(baseMinimum:bigint,quoteMinimum:bigint) {
              return dusk.write.removeLiquidityInstruction({market:LEGACY_RETIREMENT.market,owner,
                baseMint:market.baseSide.assetMint,quoteMint:market.quoteSide.assetMint,srlpMint:market.srlpMint,
                ownerBaseAccount:destinations[0],ownerQuoteAccount:destinations[1],ownerSrlpAccount:holder.address,
                srlpAmount:amount,minBaseAmountOut:baseMinimum,minQuoteAmountOut:quoteMinimum});
            }
            const quote=svm.simulateTransaction(getTransactionDecoder().decode(localTransaction([await removal(0n,0n)]).serialize()));
            if(quote instanceof FailedTransactionMetadata)throw Object.assign(new Error('Senior withdrawal rejected'),{detail:quote.err().toString(),logs:quote.meta().logs()});
            const net=destinations.map(destination=>{
              const account=quote.postAccounts().find(row=>row.address===destination.toBase58());
              if(!account)throw new Error('Missing senior net receipt');return Buffer.from(account.data).readBigUInt64LE(64);
            });
            const minimum=net.map(retirementMinimumNetPayout);
            await executeLocal([await removal(minimum[0],minimum[1])]);
            if(tokenBalance(new PublicKey(holder.address))!==0n || destinations.some((key,i)=>tokenBalance(key)!==net[i]))throw new Error('Senior withdrawal differs from quote');
            destinations.forEach((key,i)=>payouts.push({owner:holder.owner,mint:(i===0?market.baseSide:market.quoteSide).assetMint.toBase58(),account:key}));
            steps.push({status:phase==='jr'?'junior-principal-withdrawn-locally':'senior-withdrawn-locally',owner:holder.owner,srlpAmount:amount.toString(),
              baseNetRaw:String(net[0]),quoteNetRaw:String(net[1]),minimumBaseNetRaw:String(minimum[0]),minimumQuoteNetRaw:String(minimum[1])});
      }
      if(!steps.some(row=>row.status==='hlp-rejected')) {
        try {
          const market=await dusk.get.market(LEGACY_RETIREMENT.market);
          const holders=inventory.summary.receipts.find((row:any)=>row.mint===market.srlpMint.toBase58()).accounts
            .filter((row:any)=>row.owner!==LEGACY_RETIREMENT.market);
          for(let index=0;index<holders.length;index++)await withdrawSeniorHolder(holders[index],index);
        } catch(error) {const e=error as {message?:string;detail?:string;logs?:string[]};steps.push({status:'senior-rejected',error:e.message,detail:e.detail,logs:e.logs});}
      }
      if(!steps.some(row=>row.status==='hlp-rejected'||row.status==='senior-rejected')) {
        try {
          await executeLocal([await dusk.yield.fundInstruction({market:LEGACY_RETIREMENT.market,caller:payer})]);
          async function harvestAllClaims(pass:string) {
          const caughtUp=new Set<string>();
          const claims=inventory.decoded.filter((row:any)=>row.kind==='YieldAccount').sort((a:any,b:any)=>a.address.localeCompare(b.address));
          for(let index=0;index<claims.length;index++) {
            const claim=claims[index],state=claim.state,owner=new PublicKey(state.owner),lpMint=new PublicKey(state.lp_mint);
            const ownerLp=getAssociatedTokenAddressSync(lpMint,owner,true,TOKEN_2022_PROGRAM_ID);
            await executeLocal([createAssociatedTokenAccountIdempotentInstruction(payer,ownerLp,owner,lpMint,TOKEN_2022_PROGRAM_ID)]);
            const kind=state.token_kind===0?'srlp':state.token_kind===1?'hlp':'junior';
            const holderKey=owner.toBase58()+kind;
            if(kind!=='hlp' && !caughtUp.has(holderKey)) {
              let complete=false;
              for(let pass=0;pass<16;pass++) {
                const batch=await dusk.tranches.prepareHolderIncome({market:LEGACY_RETIREMENT.market,owner,kind:kind==='srlp'?'senior':'junior'});
                for(const tx of batch.transactions)await executeLocal(tx.instructions);
                if(!batch.hasMore){complete=true;break;}
              }
              if(!complete)throw new Error('Historical income catch-up exceeded one-off bound');
              caughtUp.add(holderKey);
            }
            const market=await dusk.get.market(LEGACY_RETIREMENT.market),side=state.asset_mint===market.baseSide.assetMint.toBase58()?market.baseSide:market.quoteSide;
            if(side.assetMint.toBase58()!==state.asset_mint)throw new Error('Claim asset differs');
            const raw=await connection.getAccountInfo(side.assetMint);if(!raw)throw new Error('Missing claim mint');
            const recipient=getAssociatedTokenAddressSync(side.assetMint,new PublicKey(state.recipient),true,raw.owner);
            const before=tokenBalance(recipient);
            const harvest=await dusk.write.instruction('harvest',{tokenKind:sdk.yieldTokenKindArg(kind)},{accounts:{
              market:LEGACY_RETIREMENT.market,futarchyAuthority:inventory.decoded.find((row:any)=>row.kind==='FutarchyAuthority').address,
              owner,caller:owner,assetMint:side.assetMint,lpMint,ownerLpAccount:ownerLp,reserveVault:side.reserveVault,
              interestVault:side.interestVault,recipientAssetAccount:recipient,yieldAccount:claim.address,
              tokenProgram:'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',token2022Program:TOKEN_2022_PROGRAM_ID}});
            const instructions=[createAssociatedTokenAccountIdempotentInstruction(payer,recipient,new PublicKey(state.recipient),side.assetMint,raw.owner),harvest];
            const preview=svm.simulateTransaction(getTransactionDecoder().decode(localTransaction(instructions).serialize()));
            if(preview instanceof FailedTransactionMetadata) {
              const failure=preview.err() as unknown as {index?:number;err?:()=>{code?:number}};
              const code=typeof failure.err==='function'?failure.err()?.code:undefined;
              if(failure.index!==3 || code!==idl.errors!.find(error=>error.name==='AmountZero')!.code)
                throw Object.assign(new Error('Income harvest rejected'),{detail:preview.err().toString(),logs:preview.meta().logs()});
              const snapshot=svm.getAccount(address(claim.address));
              steps.push({status:'income-no-current-payout-locally',pass,owner:state.owner,yieldAccount:claim.address,
                sourceState:snapshot.exists?Buffer.from(snapshot.data).toString('base64'):null,
                note:'AmountZero is not a waiver of an unpaid receivable; reconcile this retained claim before finalization'});
              continue;
            }
            await executeLocal(instructions);
            steps.push({status:'income-harvested-locally',pass,owner:state.owner,recipient:state.recipient,yieldAccount:claim.address,
              assetMint:side.assetMint.toBase58(),netRaw:String(tokenBalance(recipient)-before)});
          }
          }
          await harvestAllClaims('before-junior');
          const market=await dusk.get.market(LEGACY_RETIREMENT.market);
          const juniors=inventory.summary.receipts.find((row:any)=>row.mint===market.juniorMint.toBase58()).accounts;
          for(const holder of juniors) {
            const amount=tokenBalance(new PublicKey(holder.address));if(amount===0n)continue;
            const built=await dusk.tranches.convert({market:LEGACY_RETIREMENT.market,owner:holder.owner,action:{kind:'requestExit',juniorAmount:amount}});
            await executeLocal(built.instructions);
            const exit=await dusk.program.account.juniorExitAccount.fetch(built.exit);
            const attempt=await dusk.tranches.convert({market:LEGACY_RETIREMENT.market,owner:holder.owner,action:{kind:'convertExit',minimumSenior:0n}});
            const rejection=svm.simulateTransaction(getTransactionDecoder().decode(localTransaction(attempt.instructions).serialize()));
            if(!(rejection instanceof FailedTransactionMetadata))throw new Error('Junior notice unexpectedly bypassed');
            steps.push({status:'junior-exit-queued-locally',owner:holder.owner,originalReceipts:amount.toString(),
              queuedReceipts:String(exit.ticket.receipts),requestFeeReceipts:String(amount-BigInt(exit.ticket.receipts.toString())),
              readyAtSlot:String(exit.ticket.readyAt),expiresAtSlot:String(exit.ticket.expiresAt),
              immediateConversionRejection:rejection.err().toString(),note:'maturity not reached; no clock warp or notice waiver performed'});
          }
          // Evaluate ordinary conversion at each stored maturity to quote the
          // approved immediate-terminal economic result. Only the local VM's
          // clock moves; no ledger amount, receipt or token balance is patched.
          // The real retirement program still has to enforce the freeze and
          // zero-debt conditions. This is not proof that legacy code waives time.
          const requests=steps.filter(row=>row.status==='junior-exit-queued-locally')
            .sort((a,b)=>BigInt(a.readyAtSlot)<BigInt(b.readyAtSlot)?-1:1);
          for(let index=0;index<requests.length;index++) {
            const request=requests[index],state=await dusk.get.market(LEGACY_RETIREMENT.market);
            const debts=Object.entries(state.debt).filter(([key])=>/Shares|Principal/.test(key));
            if(debts.some(([,value])=>BigInt(String(value))!==0n)
              || [state.baseHlpVault,state.quoteHlpVault].some(vault=>!vault.debtShares.isZero() || !vault.debtPrincipal.isZero()
                || !vault.residualExposure.isZero() || !vault.flashCollateralDebit.isZero()))
              throw new Error('Junior terminal quote requires every lending and hLP debt to be zero');
            const clock=svm.getClock(),previousSlot=clock.slot,ready=BigInt(request.readyAtSlot);
            clock.slot=ready;clock.unixTimestamp+=(ready-previousSlot)*200n/1000n;
            svm.warpToSlot(ready);svm.setClock(clock);
            const conversion=await dusk.tranches.convert({market:LEGACY_RETIREMENT.market,owner:request.owner,
              action:{kind:'convertExit',minimumSenior:0n}});
            await executeLocal(conversion.instructions);
            const ownerSenior=getAssociatedTokenAddressSync(conversion.seniorMint,new PublicKey(request.owner),true,TOKEN_2022_PROGRAM_ID);
            await withdrawSeniorHolder({owner:request.owner,address:ownerSenior.toBase58()},index,'jr');
            steps.push({status:'junior-terminal-economics-quoted-locally',owner:request.owner,
              evaluatedAtSlot:ready.toString(),sourceBankSlot:bank.slot,normalExitFeeBps:50,
              note:'ordinary-maturity calculation models approved immediate terminal payout after freeze and zero-debt checks; no live execution'});
          }
          await harvestAllClaims('after-junior');
          const finalState=await dusk.get.market(LEGACY_RETIREMENT.market);
          for(const mint of [finalState.baseSide.assetMint,finalState.quoteSide.assetMint]) {
            const asset=finalState.baseSide.assetMint.equals(mint)?0:1;
            const cash=[asset,asset+2].reduce((sum,i)=>sum+BigInt(finalState.income.revenue[i].operatorClaimable.toString()),0n);
            if(cash===0n)continue;
            const claim=await dusk.operator.claim({market:LEGACY_RETIREMENT.market,assetMint:mint,payer});
            const before=tokenBalance(claim.recipientAssetAccount);await executeLocal(claim.transaction.instructions);
            steps.push({status:'operator-income-claimed-locally',recipient:claim.recipient.toBase58(),assetMint:mint.toBase58(),
              netRaw:String(tokenBalance(claim.recipientAssetAccount)-before)});
          }
        } catch(error) {const e=error as {message?:string;detail?:string;logs?:string[]};steps.push({status:'income-or-junior-rejected',error:e.message,detail:e.detail,logs:e.logs});}
      }
    }
    const currentMarket=await dusk.get.market(LEGACY_RETIREMENT.market);
    const assetMints=[currentMarket.baseSide.assetMint.toBase58(),currentMarket.quoteSide.assetMint.toBase58()];
    const originalTokenAmounts=new Map(assetMints.map(mint=>[mint,0n]));
    const originalOwnerTokens=new Map<string,{base:bigint;quote:bigint}>(inventory.summary.owners.map((owner:string)=>[owner,{base:0n,quote:0n}]));
    for(const row of bank.accounts) {
      if(!row.account || row.account.owner!=='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')continue;
      const raw=Buffer.from(row.account.data,'base64');if(raw.length!==165)continue;
      const mint=new PublicKey(raw.subarray(0,32)).toBase58();if(!originalTokenAmounts.has(mint))continue;
      originalTokenAmounts.set(mint,originalTokenAmounts.get(mint)!+raw.readBigUInt64LE(64));
      const owner=new PublicKey(raw.subarray(32,64)).toBase58(),ledger=originalOwnerTokens.get(owner);
      if(ledger)ledger[mint===assetMints[0]?'base':'quote']+=raw.readBigUInt64LE(64);
    }
    const totals=new Map(assetMints.map(mint=>[mint,0n]));
    const ownerLedger=new Map<string,{base:bigint;quote:bigint}>(inventory.summary.owners.map((owner:string)=>[owner,{base:0n,quote:0n}]));
    for(const row of svm.getProgramAccounts(address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'))) {
      const raw=Buffer.from(row.data);if(raw.length!==165)continue;
      const mint=new PublicKey(raw.subarray(0,32)).toBase58();if(!totals.has(mint))continue;
      const amount=raw.readBigUInt64LE(64);totals.set(mint,totals.get(mint)!+amount);
      const owner=new PublicKey(raw.subarray(32,64)).toBase58(),ledger=ownerLedger.get(owner);
      if(ledger)ledger[mint===assetMints[0]?'base':'quote']+=amount;
    }
    if(assetMints.some(mint=>totals.get(mint)!==originalTokenAmounts.get(mint)))throw new Error('Native retirement token conservation failed');
    for(const [owner,value] of ownerLedger) {
      const original=originalOwnerTokens.get(owner)!;value.base-=original.base;value.quote-=original.quote;
      if(value.base<0n || value.quote<0n)throw new Error('Rehearsal spent pre-existing wallet tokens');
    }
    runs.push({strategy:variant.label,order:order.map(row=>row.address),steps,
      allLeverageClosed,remainingDebt:Object.fromEntries(Object.entries(currentMarket.debt).filter(([key])=>/Shares|Principal/.test(key)).map(([key,value])=>[key,String(value)])),
      remainingHlp:{base:String(currentMarket.baseHlpVault.hlpSupply),quote:String(currentMarket.quoteHlpVault.hlpSupply)},
      evaluationClock:{slot:String(svm.getClock().slot),unixTimestamp:String(svm.getClock().unixTimestamp)},
      finalMarket:jsonState(currentMarket),
      finalReceiptSupplies:inventory.summary.receipts.map((receipt:any)=>{
        const mint=svm.getAccount(address(receipt.mint));if(!mint.exists)throw new Error('Missing final receipt mint');
        return {mint:receipt.mint,supply:Buffer.from(mint.data).readBigUInt64LE(36).toString()};
      }),
      finalEconomicAccounts:svm.getProgramAccounts(address(pin.dusk.programId)).flatMap(row=>{
        const data=Buffer.from(row.data),type=idl.accounts!.find(type=>data.subarray(0,8).equals(Buffer.from(type.discriminator)));
        return type?[{address:row.address,kind:type.name,sourceBytes:data.toString('base64'),state:jsonState(coder.accounts.decode(type.name,data))}]:[];
      }),
      realizedOwnerTokens:[...ownerLedger].map(([owner,value])=>({owner,baseRaw:String(value.base),quoteRaw:String(value.quote),
        minimumBaseRaw:String(retirementMinimumNetPayout(value.base)),minimumQuoteRaw:String(retirementMinimumNetPayout(value.quote))})),
      tokenConservation:assetMints.map(mint=>({mint,before:String(originalTokenAmounts.get(mint)),after:String(totals.get(mint))}))});
  }
  const best=runs.find(run=>run.strategy==='longs-loans-convert-base-retain-quote-short');
  let proposal:any;
  try {
    if(!best)throw new Error('No complete retirement strategy');
    const initialMarketRow=bank.accounts.find(row=>row.address===LEGACY_RETIREMENT.market)!;
    const initial=coder.accounts.decode('Market',Buffer.from(initialMarketRow.account!.data,'base64')) as any;
    const mint=bank.accounts.find(row=>row.address===initial.srlp_mint.toBase58())!;
    const locked=BigInt(initial.base_side.shares.srlp_supply.toString())-BigInt(initial.tranches.junior_reserve_shares.toString())
      -Buffer.from(mint.account!.data,'base64').readBigUInt64LE(36);
    const custody={baseRaw:0n,quoteRaw:0n};
    for(const row of bank.accounts) {
      if(!row.account || row.account.owner!=='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')continue;
      const data=Buffer.from(row.account.data,'base64');if(data.length!==165 || new PublicKey(data.subarray(32,64)).toBase58()!==LEGACY_RETIREMENT.market)continue;
      const mint=new PublicKey(data.subarray(0,32)).toBase58();
      if(mint===initial.base_side.asset_mint.toBase58())custody.baseRaw+=data.readBigUInt64LE(64);
      else if(mint===initial.quote_side.asset_mint.toBase58())custody.quoteRaw+=data.readBigUInt64LE(64);
      else if(data.readBigUInt64LE(64)>0n)throw new Error('Market custody contains an unclassified asset');
    }
    proposal=proposedRetirementTokens(best,{baseRaw:String(custody.baseRaw),quoteRaw:String(custody.quoteRaw)},{
      owners:inventory.summary.owners,
      yieldAccounts:inventory.decoded.filter((row:any)=>row.kind==='YieldAccount').map((row:any)=>row.address),
      receiptMints:inventory.summary.receipts.map((row:any)=>row.mint),
      assetMints:[initial.base_side.asset_mint.toBase58(),initial.quote_side.asset_mint.toBase58()],
      lockedSeniorShares:locked.toString(),
    });
  } catch(error) {proposal={status:'blocked',executionReady:false,reason:error instanceof Error?error.message:'incomplete accounting'};}
  const result={schemaVersion:'dusk-legacy-close-rehearsal.v1',observedAt:new Date().toISOString(),
    localOnly:true,policy:RETIREMENT_CLOSURE_POLICY,inventorySha256:contentSha256,bankSha256:retirementObservationHash(bank),bank,
    ...(walletObservation?{walletObservation,walletObservationSha256:retirementObservationHash(walletObservation),
      walletObservationBasis:'separate-finalized-plain-wallet-SOL; protocol/token state stays in one economic bank'}:{}),
    ...(inventory.sourceModel?{sourceModel:inventory.sourceModel,bankKind:'reconstructed-quote-model'}:{}),
    assumptions:['signature checks disabled only in local LiteSVM','existing owner close semantics; no forced authority implemented',
      'discovery completeness still requires terminal market freeze and rescan',
      'junior ordinary-maturity projection models the approved immediate terminal exception; live retirement code is not implemented',
      'orders, remaining protocol liabilities, rounding and permanent seed need final reconciliation',
      'loan conversion alternatives are indicative; final asset conversion and aggregate net guards require review'],
    settlementReady:false,proposal,runs};
  writeFileSync(resolve(process.argv[3]),JSON.stringify({...result,contentSha256:retirementObservationHash(result)},null,2)+'\n',{flag:'wx',mode:0o600});
  console.log(JSON.stringify({slot:bank.slot,accounts:addresses.length,runs:runs.map(run=>({closed:run.steps.filter(row=>row.status==='closed-locally').length,
    strategy:run.strategy,allLeverageClosed:run.allLeverageClosed,rejection:run.steps.find(row=>row.status==='rejected'||row.status==='loan-rejected')}))},null,2));
}
if(require.main===module)main().catch(error=>{console.error('Read-only retirement rehearsal failed:',error instanceof Error?error.message:'unknown error');process.exitCode=1;});
