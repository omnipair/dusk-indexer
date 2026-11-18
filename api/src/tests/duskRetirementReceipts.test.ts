import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BorshCoder,BN,utils } from '@coral-xyz/anchor';
import type { Idl } from '@coral-xyz/anchor';
import { Keypair,PublicKey,TransactionInstruction,TransactionMessage,VersionedTransaction } from '@solana/web3.js';
import { validateRetirementReceipts } from '../services/duskRetirementReceipts';
import type { RetirementReceiptManifest,RetirementTransactionObservation } from '../services/duskRetirementReceipts';
const idl=JSON.parse(readFileSync(resolve(__dirname,'../../src/tests/fixtures/legacy-retirement-idl.json'),'utf8')) as Idl;
const coder=new BorshCoder(idl),program=new PublicKey(idl.address);
const key=(n:number)=>Keypair.fromSeed(new Uint8Array(32).fill(n));
function fixture(){
  const users=Array.from({length:6},(_,index)=>({owner:key(index+1).publicKey.toBase58(),baseRaw:String(index+10),quoteRaw:String(index+20)}));
  const manifest:RetirementReceiptManifest={sourceSlot:20,onChainManifestSha256:'ab'.repeat(32),custodyRaw:['77','137'],users,
    treasury:{owner:key(8).publicKey.toBase58(),baseRaw:'2',quoteRaw:'2'}};
  const definitions=[{name:'LegacyRetirementBegun',data:{manifest_sha256:Array(32).fill(171),source_slot:new BN(20),custody:[new BN(77),new BN(137)]}},
    ...users.map(user=>({name:'LegacyOwnerCleared',data:{owner:new PublicKey(user.owner),rent_lamports:new BN(42)}})),
    ...[...users,manifest.treasury].map((user,index)=>({name:'LegacyRetirementPaid',data:{owner:new PublicKey(user.owner),base:new BN(user.baseRaw),quote:new BN(user.quoteRaw),treasury:index===6}}))];
  const observations:RetirementTransactionObservation[]=definitions.map(({name,data},index)=>{
    const signer=key(9),tx=new VersionedTransaction(new TransactionMessage({payerKey:signer.publicKey,recentBlockhash:key(10).publicKey.toBase58(),
      instructions:[new TransactionInstruction({programId:program,keys:[],data:Buffer.from([index])})]}).compileToV0Message());tx.sign([signer]);
    const signature=utils.bytes.bs58.encode(Buffer.from(tx.signatures[0])),slot=100+index;
    const event=Buffer.concat([Buffer.from('e445a52e51cb9a1d','hex'),Buffer.from(idl.events!.find(row=>row.name===name)!.discriminator),coder.types.encode(name,data)]);
    return {signature,transaction:{slot,blockTime:1000+index,version:0,transaction:[Buffer.from(tx.serialize()).toString('base64'),'base64'],meta:{err:null,
      innerInstructions:[{index:0,instructions:[{programIdIndex:1,accounts:[],data:utils.bytes.bs58.encode(event),stackHeight:2}]}]}},
      block:{blockhash:key(10).publicKey.toBase58(),parentSlot:slot-1,blockTime:1000+index,signatures:[signature]}};
  });
  return {manifest,observations};
}
test('all six actual clear/payout receipts match the manifest while raw CPI evidence remains unchanged',()=>{
  const {manifest,observations}=fixture(),before=JSON.stringify(observations),result=validateRetirementReceipts(observations,idl,manifest,10);
  assert.equal(result.usersPaid,6);assert.equal(result.events.length,14);assert.equal(result.treasuryPaid,true);
  assert.equal(result.events[0].outerInstructionIndex,0);assert.equal(result.events[0].innerInstructionIndex,0);assert.equal(result.events[0].stackHeight,2);
  assert.equal(JSON.stringify(observations),before);assert.equal(result.observationsSha256.length,64);
});
test('a forged signed message, wrong finalized block, missing stack or earlier deployment cannot certify receipts',()=>{
  const mutations:((v:ReturnType<typeof fixture>)=>void)[]=[
    v=>{const tx=Buffer.from(v.observations[0].transaction.transaction[0],'base64');tx[tx.length-1]^=1;v.observations[0].transaction.transaction[0]=tx.toString('base64');},
    v=>{v.observations[0].block.signatures=[];},v=>{v.observations[0].transaction.meta.innerInstructions![0].instructions[0].stackHeight=null;},
    v=>{v.observations[0].transaction.blockTime++;},v=>{v.observations[0].signature=v.observations[1].signature;},
    v=>{v.observations[0].transaction.slot=1;},
  ];
  for(const mutate of mutations){const value=fixture();mutate(value);assert.throws(()=>validateRetirementReceipts(value.observations,idl,value.manifest,10));}
});
test('missing, failed, duplicated, wrong-amount and wrong-role payments never certify completion',()=>{
  const mutations:((v:ReturnType<typeof fixture>)=>void)[]=[
    v=>{v.observations.pop();},v=>{v.observations[7].transaction.meta.err={InstructionError:[0,'custom']};},
    v=>{v.observations.push(v.observations[0]);},v=>{v.manifest.users[0].baseRaw='11';},
    v=>{v.manifest.treasury.owner=v.manifest.users[0].owner;},v=>{v.manifest.onChainManifestSha256='00'.repeat(32);},
  ];
  for(const mutate of mutations){const value=fixture();mutate(value);assert.throws(()=>validateRetirementReceipts(value.observations,idl,value.manifest,10));}
});
test('local rehearsal evidence is refused before any network or verifier is invoked',async t=>{
  const {mkdtempSync,writeFileSync,rmSync}=await import('node:fs'),{tmpdir}=await import('node:os');
  const {canonicalJson,sha256}=await import('../config/duskProtocol');
  const {archiveRetirementReceipts}=await import('../scripts/duskRetirementReceiptArchive');
  const directory=mkdtempSync(resolve(tmpdir(),'dusk-receipt-test-'));
  const save=(name:string,body:Record<string,unknown>)=>{const path=resolve(directory,name);writeFileSync(path,JSON.stringify({...body,contentSha256:sha256(canonicalJson(body))}));return path;};
  const manifest=save('manifest.json',{schemaVersion:'dusk-retirement-payout-manifest.v1',localOnly:true}),capture=save('capture.json',{localOnly:true});
  const network=t.mock.method(globalThis,'fetch',async()=>{throw new Error('Unexpected network');});
  try{await assert.rejects(archiveRetirementReceipts(['not-a-checkout','not-a-bundle',manifest,capture,'model','quote','proof','proof',resolve(directory,'out.json')]),/Local manifests/);assert.equal(network.mock.callCount(),0);}
  finally{rmSync(directory,{recursive:true});}
});
