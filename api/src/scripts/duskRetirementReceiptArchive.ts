/** Local read-only operator. Inputs are actual reviewed settlement evidence. */
import assert from 'node:assert/strict';
import { readFileSync,writeFileSync,appendFileSync,existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync,spawnSync } from 'node:child_process';
import { Connection,PublicKey } from '@solana/web3.js';
import { inflateSync } from 'node:zlib';
import type { Idl } from '@coral-xyz/anchor';
import { canonicalJson,sha256 } from '../config/duskProtocol';
import { LEGACY_RETIREMENT } from '../services/duskRetirementInventory';
import { validateRetirementReceipts } from '../services/duskRetirementReceipts';
import type { RetirementTransactionObservation } from '../services/duskRetirementReceipts';

const json=(path:string)=>JSON.parse(readFileSync(resolve(path),'utf8'));
function evidence(path:string){const value=json(path),{contentSha256,...body}=value;assert.equal(contentSha256,sha256(canonicalJson(body)),'Evidence hash differs');return value;}
function accountBytes(account:any){assert.ok(account);return {...account,owner:account.owner.toBase58(),data:account.data.toString('base64')};}
export async function archiveRetirementReceipts(args:string[]){
  assert.equal(args.length,9,'Expected CORE_CHECKOUT BUNDLE MANIFEST CAPTURE MODEL QUOTE MODEL_PROOF FROZEN_PROOF NEW_OUTPUT');
  const [core,bundlePath,manifestPath,...rest]=args;
  const output=rest.pop()!,paths=[manifestPath,...rest],manifest=evidence(manifestPath),capture=evidence(paths[1]);
  assert.equal(manifest.schemaVersion,'dusk-retirement-payout-manifest.v1');assert.equal(manifest.localOnly,false,'Local manifests cannot archive actual payments');
  assert.equal(capture.localOnly,false,'Local captures cannot archive actual payments');
  const bundle=json(resolve(bundlePath,'manifest.json')),scope=json(resolve(bundlePath,'scope.json'));
  assert.equal(bundle.schema,'dusk-retirement-bundle.v1');
  assert.equal(bundle.cluster,'mainnet-beta');assert.equal(bundle.genesisHash,'5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d');
  assert.equal(bundle.program,LEGACY_RETIREMENT.program);assert.equal(scope.program,LEGACY_RETIREMENT.program);assert.equal(scope.market,LEGACY_RETIREMENT.market);
  assert.equal(scope.legacyIdentity.delegate.programId,LEGACY_RETIREMENT.delegate);assert.equal(manifest.program,scope.program);assert.equal(manifest.market,scope.market);assert.match(bundle.sourceCommit,/^[a-f0-9]{40}$/);
  assert.equal(manifest.bundleSha256,sha256(canonicalJson(bundle)));
  for(const [name,value] of Object.entries(bundle.files) as [string,{sha256:string;size:number}][]){
    assert.ok(['dusk.so','dusk.json','dusk.ts','scope.json'].includes(name),'Unexpected bundle path');
    const bytes=readFileSync(resolve(bundlePath,name));assert.equal(bytes.length,value.size);assert.equal(sha256(bytes),value.sha256,'Release artifact hash differs');
  }
  const git=(...options:string[])=>execFileSync('git',options,{cwd:resolve(core),encoding:'utf8'}).trim();
  assert.equal(git('rev-parse','HEAD'),bundle.sourceCommit,'Use the exact reviewed program checkout');assert.equal(git('status','--porcelain','--untracked-files=no'),'');
  git('merge-base','--is-ancestor',bundle.sourceCommit,'origin/main');
  const endpoint=process.env.MAINNET_RPC_URL;assert.ok(endpoint,'MAINNET_RPC_URL required');
  const verifyCompleted=()=>{
    const result=spawnSync('node',[resolve(core,'scripts/retirement/local.mjs'),'verify',resolve(bundlePath),...paths.map(path=>resolve(path))],
      {cwd:resolve(core),encoding:'utf8',env:process.env,maxBuffer:1024*1024});
    assert.equal(result.status,0,'Completed-state verification failed; no archive was produced');
    const verified=JSON.parse(result.stdout.trim());assert.equal(verified.completed,true);assert.equal(verified.manifestSha256,manifest.onChainManifestSha256);
    assert.deepEqual(verified.masks,[(1<<scope.owners.length)-1,(1<<scope.owners.length)-1]);return verified;
  };
  const verified=verifyCompleted(),rpc=new Connection(endpoint,'finalized');assert.equal(await rpc.getGenesisHash(),bundle.genesisHash);
  const program=new PublicKey(scope.program),state=PublicKey.findProgramAddressSync([Buffer.from('legacy_retirement'),new PublicKey(scope.market).toBuffer()],program)[0];
  const idl=readFileSync(resolve(bundlePath,'dusk.json')),binary=readFileSync(resolve(bundlePath,'dusk.so'));
  const idlKey=async(id:string)=>{const key=new PublicKey(id),[base]=PublicKey.findProgramAddressSync([],key);return PublicKey.createWithSeed(base,'anchor:idl',key);};
  const ids=[scope.program,scope.programData,await idlKey(scope.program),scope.legacyIdentity.delegate.programId,scope.legacyIdentity.delegate.deployment.programData,await idlKey(scope.legacyIdentity.delegate.programId)];
  const readDeployment=async(minContextSlot=0)=>{
    const result=await rpc.getMultipleAccountsInfoAndContext(ids.map((value:any)=>new PublicKey(value)),{commitment:'finalized',minContextSlot});
    const rows=result.value;assert.ok(rows.every(Boolean),'Missing deployment evidence');
    const data=rows[1]!.data;assert.equal(data.readUInt32LE(0),3);assert.equal(data[12],1);assert.equal(new PublicKey(data.subarray(13,45)).toBase58(),scope.authority);
    assert.ok(data.subarray(45,45+binary.length).equals(binary)&&data.subarray(45+binary.length).every(byte=>byte===0),'Temporary executable differs');
    const length=rows[2]!.data.readUInt32LE(40),onChainIdl=inflateSync(rows[2]!.data.subarray(44,44+length),{maxOutputLength:16*1024*1024});
    assert.equal(sha256(canonicalJson(JSON.parse(onChainIdl.toString()))),sha256(canonicalJson(JSON.parse(idl.toString()))));
    assert.equal(sha256(rows[4]!.data.subarray(45)),scope.legacyIdentity.delegate.binarySha256,'Delegate changed before archival');
    return {slot:result.context.slot,deploySlot:Number(data.readBigUInt64LE(4)),accounts:ids.map((id:any,index)=>({address:new PublicKey(id).toBase58(),account:accountBytes(rows[index])}))};
  };
  assert.ok(!existsSync(resolve(output)),'Archive output already exists');
  const before=await readDeployment(),journal=resolve(output)+'.observations.jsonl';
  const identity={cluster:'mainnet-beta',genesisHash:bundle.genesisHash,programId:scope.program,idlHash:sha256(canonicalJson(JSON.parse(idl.toString()))),protocolRevision:`mainnet-retirement-${bundle.sourceCommit.slice(0,12)}`};
  writeFileSync(journal,JSON.stringify({kind:'deployment-before',protocolIdentity:identity,sourceCommit:bundle.sourceCommit,
    manifestSha256:manifest.contentSha256,observation:before})+'\n',{flag:'wx',mode:0o600});
  const observe=(kind:string,observation:unknown)=>appendFileSync(journal,JSON.stringify({kind,observation})+'\n',{mode:0o600});
  // Use raw getTransaction(base64) responses so future replay retains the signed
  // message, complete inner-instruction order/stack heights and loaded addresses.
  const read=async(method:string,params:unknown[])=>{
    assert.ok(['getTransaction','getBlock'].includes(method));
    const response=await fetch(endpoint,{method:'POST',signal:AbortSignal.timeout(30000),headers:{'Content-Type':'application/json'},
      body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});assert.ok(response.ok,'Read-only receipt RPC failed');
    const body=await response.json() as any;assert.ok(!body.error&&body.result,'Receipt RPC result unavailable');return body.result;
  };
  const signatures:string[]=[];let cursor:string|undefined,complete=false;
  for(let page=0;page<10;page++){
    const rows=await rpc.getSignaturesForAddress(state,{limit:1000,...(cursor?{before:cursor}:{})},'finalized');
    observe('signature-page',rows);
    signatures.push(...rows.filter(row=>row.slot>before.deploySlot).map(row=>row.signature));
    if(rows.length<1000||rows.some(row=>row.slot<=before.deploySlot)){complete=true;break;}
    cursor=rows.at(-1)!.signature;
  }
  assert.ok(complete,'Receipt history exceeds bounded scan; reconcile before continuing');
  const observations:RetirementTransactionObservation[]=[],blocks=new Map<number,any>();
  for(const signature of signatures){
    const transaction=await read('getTransaction',[signature,{encoding:'base64',commitment:'finalized',maxSupportedTransactionVersion:0}]);
    let block=blocks.get(transaction.slot);
    if(!block){block=await read('getBlock',[transaction.slot,{transactionDetails:'signatures',rewards:false,commitment:'finalized',maxSupportedTransactionVersion:0}]);blocks.set(transaction.slot,block);}
    observe('transaction',{signature,transaction,block});
    assert.ok(transaction.slot>before.deploySlot&&transaction.slot<=before.slot,'Transaction lies outside verified temporary interval');
    observations.push({signature,transaction,block});
  }
  const validated=validateRetirementReceipts(observations,JSON.parse(idl.toString()) as Idl,manifest,before.deploySlot);
  const after=await readDeployment(before.slot);observe('deployment-after',after);assert.deepEqual(after.accounts,before.accounts,'Deployment changed during receipt archival');
  verifyCompleted();
  const body={schemaVersion:'dusk-retirement-receipt-archive.v1',readOnly:true,localOnly:false,observedAt:new Date().toISOString(),
    protocolIdentity:identity,
    sourceCommit:bundle.sourceCommit,bundleSha256:manifest.bundleSha256,manifestSha256:manifest.contentSha256,onChainManifestSha256:manifest.onChainManifestSha256,
    deployment:before,verifiedThroughSlot:after.slot,generatedIdl:JSON.parse(idl.toString()),verified,...validated,observations,
    projectionStatus:'raw finalized archive only; decode and project through the common identity-scoped ingestion path before normal promotion',
    limitations:['Finalized RPC is the chain-observation boundary','CPI validation coordinates are not canonical event keys','No hypothetical swaps or ordinary financial events are synthesized']};
  writeFileSync(resolve(output),JSON.stringify({...body,contentSha256:sha256(canonicalJson(body))},null,2)+'\n',{flag:'wx',mode:0o600});
  return {usersPaid:validated.usersPaid,transactions:observations.length,events:validated.events.length,readOnly:true};
}
if(require.main===module)archiveRetirementReceipts(process.argv.slice(2)).then(result=>console.log(JSON.stringify(result)))
  .catch(()=>{console.error('Read-only retirement receipt archival failed; check reviewed evidence and finalized RPC. No writes were submitted.');process.exitCode=1;});
