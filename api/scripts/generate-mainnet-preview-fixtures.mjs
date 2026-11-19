/** Generate synthetic offline preview banks for the exact active SBF/IDL.
 * Never contacts an RPC, creates a live market, signs, or sends transactions.
 */
import assert from 'node:assert/strict';
import { readFileSync,writeFileSync } from 'node:fs';
import { resolve,dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
const api=resolve(dirname(fileURLToPath(import.meta.url)),'..'),require=createRequire(resolve(api,'package.json'));
const { BorshCoder,BN }=require('@coral-xyz/anchor');
const { IdlCoder }=require('@coral-xyz/anchor/dist/cjs/coder/borsh/idl');
const { PublicKey }=require('@solana/web3.js');
const { convertIdlToCamelCase }=require('@coral-xyz/anchor/dist/cjs/idl');
const { IDL,DEFAULT_READONLY_PUBLIC_KEY }=await import('@omnipair/dusk-sdk');
const oldIdl=JSON.parse(readFileSync(resolve(api,'../protocol/archive/mainnet-2026-11-14/idl/dusk.json')));
const old=JSON.parse(readFileSync(resolve(api,'src/tests/fixtures/virtual-book-layout17.json')));
const previous=new BorshCoder(oldIdl).accounts.decode('Market',Buffer.from(old.result.value.accounts[0].data[0],'base64'));
function value(type,old){
 if(typeof type==='string'){
  if(old!==undefined)return old;
  if(type==='pubkey')return PublicKey.default;
  if(type==='bool')return false;
  if(type==='string')return '';
  if(type==='bytes')return Buffer.alloc(0);
  return ['u64','i64','u128','i128','u256','i256'].includes(type)?new BN(0):0;
 }
 if('defined'in type){const definition=IDL.types.find(row=>row.name===type.defined.name).type;
  if(definition.kind==='enum')return old??{[definition.variants[0].name]:{}};
  return Object.fromEntries(definition.fields.map(field=>[field.name,value(field.type,old?.[field.name])]));}
 if('option'in type)return old==null?null:value(type.option,old);
 if('vec'in type)return (old??[]).map(x=>value(type.vec,x));
 if('array'in type)return Array.from({length:type.array[1]},(_,i)=>value(type.array[0],old?.[i]));
 throw Error('Unsupported offline fixture type');
}
const market=value({defined:{name:'Market'}},previous);market.version=19;
const marketLayout=IdlCoder.typeDefLayout({typeDef:IDL.types.find(row=>row.name==='Market'),types:IDL.types});
const body=Buffer.alloc(32768),length=marketLayout.encode(market,body);
const marketBytes=Buffer.concat([Buffer.from(IDL.accounts.find(row=>row.name==='Market').discriminator),body.subarray(0,length)]);
const staticFixture=structuredClone(old);staticFixture.result.value.accounts[0].data=[marketBytes.toString('base64'),'base64'];
staticFixture.protocolRevision='mainnet-2026-11-19';staticFixture.sdkVersion='3.0.1';
staticFixture.provenance='Synthetic layout-19 transport/decoder fixture re-encoded from layout-17 financial inputs. Historical preview return data is retained for ABI/decoder regressions; this is not a current SBF receipt or a live market. Separate SBF bank fixtures execute the current binary.';
writeFileSync(resolve(api,'src/tests/fixtures/virtual-book-layout19.json'),JSON.stringify(staticFixture,null,2)+'\n');
const input=resolve(process.argv[2]??'');assert.ok(process.argv[2],'Expected a current exact-source keeper SBF bank fixture');
const captureBytes=readFileSync(input),capture=JSON.parse(captureBytes);
const protocol=resolve(api,'../protocol'),lock=JSON.parse(readFileSync(resolve(protocol,'protocol.lock.json')));
assert.equal(capture.sourceCommit,lock.source.gitCommit);
const dusk=lock.programs.find(p=>p.name==='dusk'),delegate=lock.programs.find(p=>p.name==='leverage_delegate');
const slot=Math.max(...lock.programs.map(p=>p.deployment.deploySlot))+1;
const accounts=Object.entries(capture.bank).map(([address,a])=>({address,account:{owner:a.owner,executable:a.executable,lamports:Number(a.lamports),rentEpoch:'0',data:Buffer.from(a.data).toString('base64')}}));
const clock=accounts.find(a=>a.address==='SysvarC1ock11111111111111111111111111111111');assert.ok(clock);
const clockBytes=Buffer.from(clock.account.data,'base64');clockBytes.writeBigUInt64LE(BigInt(slot),0);clock.account.data=clockBytes.toString('base64');
// Explicit original smoke-harness Rent, not a fabricated mainnet observation.
const rent=Buffer.alloc(17);rent.writeBigUInt64LE(3480n,0);rent.writeDoubleLE(2,8);rent[16]=50;
accounts.push({address:'SysvarRent111111111111111111111111111111111',account:{owner:'Sysvar1111111111111111111111111111111111111',executable:false,lamports:1009200,rentEpoch:'0',data:rent.toString('base64')}});
const fixtureRequire=createRequire(resolve(dirname(input),'../../package.json'));
const {LiteSVM:HarnessSVM}=fixtureRequire('litesvm');
const harness=new HarnessSVM();
for(const row of [...accounts]){
 if(!row.account.executable||row.address===dusk.programId||row.account.owner!=='BPFLoaderUpgradeab1e11111111111111111111111')continue;
 const raw=Buffer.from(row.account.data,'base64');assert.equal(raw.readUInt32LE(0),2);
 const dataKey=new PublicKey(raw.subarray(4,36));
 if(accounts.some(a=>a.address===dataKey.toBase58()))continue;
 const original=harness.getAccount(new PublicKey(row.address)),data=harness.getAccount(dataKey);
 assert.ok(original&&data&&Buffer.from(original.data).equals(raw),'CPI must match the original smoke-harness executable');
 accounts.push({address:dataKey.toBase58(),account:{owner:data.owner.toBase58(),executable:data.executable,lamports:data.lamports,rentEpoch:'0',data:Buffer.from(data.data).toString('base64')}});
}
if(!accounts.some(row=>row.address===DEFAULT_READONLY_PUBLIC_KEY.toBase58()))accounts.push({address:DEFAULT_READONLY_PUBLIC_KEY.toBase58(),account:{owner:'11111111111111111111111111111111',executable:false,lamports:10000000000,rentEpoch:'0',data:''}});
const bank={slot,accounts};
const {deploymentIdentityFingerprint}=require(resolve(api,'dist/services/duskDeploymentService.js'));
const deployment={schemaVersion:'dusk-deployment.v2',network:lock.cluster.name,genesisHash:lock.cluster.genesisHash,programId:dusk.programId,programDataAddress:dusk.deployment.programData,programDataSlot:String(dusk.deployment.deploySlot),programUpgradeAuthority:dusk.deployment.upgradeAuthority,leverageDelegateProgramId:delegate.programId,leverageDelegateProgramDataAddress:delegate.deployment.programData,leverageDelegateProgramDataSlot:String(delegate.deployment.deploySlot),leverageDelegateUpgradeAuthority:delegate.deployment.upgradeAuthority,idlSha256:dusk.idl.canonicalSha256,idlRawSha256:dusk.idl.sha256,leverageDelegateIdlSha256:delegate.idl.canonicalSha256,leverageDelegateIdlRawSha256:delegate.idl.sha256,commitment:'confirmed',sourceSlot:slot,observedAt:'2026-11-19T00:00:00.000Z',apiStartedAt:null,buildRevision:'offline-sbf-fixture',programBinarySha256:dusk.binary.sha256,leverageDelegateBinarySha256:delegate.binary.sha256};
deployment.deploymentIdentitySha256=deploymentIdentityFingerprint(deployment);
const selection={market:capture.market,groupingBps:10,levels:12};
const {quoteFrozenVirtualBook}=require(resolve(api,'dist/services/duskFrozenVirtualBookEngine.js'));
const result=await quoteFrozenVirtualBook(bank,selection,deployment);
const output={schemaVersion:'dusk-synthetic-frozen-book.v1',note:'Synthetic exact-source SBF harness bank, with Clock.slot advanced to the verified successor boundary. This is offline test evidence, not a mainnet market or transaction.',sourceCommit:capture.sourceCommit,sourceFixtureSha256:createHash('sha256').update(captureBytes).digest('hex'),expectedMid:result.book.mid,bank,selection,deployment};
writeFileSync(resolve(api,'src/tests/fixtures/virtual-book-layout19-bank.json.gz'),gzipSync(Buffer.from(JSON.stringify(output))));
console.log(JSON.stringify({market:capture.market,slot,mid:result.book.mid,bids:result.book.bids.length,asks:result.book.asks.length}));
