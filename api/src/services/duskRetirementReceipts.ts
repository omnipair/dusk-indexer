/** Read-only retirement receipts. Never creates ordinary financial events or projections. */
import assert from 'node:assert/strict';
import { createPublicKey,verify } from 'node:crypto';
import { BorshCoder,utils } from '@coral-xyz/anchor';
import type { Idl } from '@coral-xyz/anchor';
import { PublicKey,VersionedTransaction } from '@solana/web3.js';
import { canonicalJson,sha256 } from '../config/duskProtocol';

export interface RetirementReceiptManifest {
  sourceSlot:number;onChainManifestSha256:string;custodyRaw:string[];
  users:{owner:string;baseRaw:string;quoteRaw:string}[];treasury:{owner:string;baseRaw:string;quoteRaw:string};
}
export interface RetirementTransactionObservation {
  signature:string;
  transaction:{slot:number;blockTime:number;version:0|'legacy';transaction:[string,'base64'];meta:{err:unknown;
    loadedAddresses?:{writable:string[];readonly:string[]};innerInstructions:{index:number;instructions:{programIdIndex:number;accounts:number[];data:string;stackHeight:number|null}[]}[]|null}};
  block:{blockhash:string;parentSlot:number;blockTime:number;signatures:string[]};
}
export interface RetirementReceiptEvent {signature:string;slot:number;blockhash:string;outerInstructionIndex:number;innerInstructionIndex:number;stackHeight:number;name:string;rawEvent:string;data:Record<string,any>}
const cpiTag=Buffer.from('e445a52e51cb9a1d','hex');
const json=(value:any):any=>value?.toBase58?value.toBase58():value?.constructor?.name==='BN'?value.toString(10):Array.isArray(value)?value.map(json)
  :value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([key,entry])=>[key,json(entry)])):value;

/** Verify signatures and exact finalized block membership before examining CPI
 * payloads. Preserve original arrays/stack heights for the common indexer decoder;
 * these validation coordinates are not canonical event keys or projections. */
export function validateRetirementReceipts(observations:RetirementTransactionObservation[],idl:Idl,manifest:RetirementReceiptManifest,deploySlot:number){
  assert.ok(observations.length>0&&observations.length<=10000,'Invalid bounded retirement receipt observations');
  assert.ok(Number.isSafeInteger(deploySlot)&&deploySlot>=0&&manifest.users.length>=1&&manifest.users.length<=8);
  assert.match(manifest.onChainManifestSha256,/^[a-f0-9]{64}$/);
  for(const [side,name] of ['baseRaw','quoteRaw'].entries()){
    const values=[...manifest.users,manifest.treasury].map(user=>{assert.match(user[name as 'baseRaw'],/^(0|[1-9]\d*)$/);const value=BigInt(user[name as 'baseRaw']);assert.ok(value<1n<<64n);return value;});
    assert.equal(values.reduce((sum,value)=>sum+value,0n).toString(),manifest.custodyRaw[side],'Receipt budget does not conserve custody');
  }
  const coder=new BorshCoder(idl),events:RetirementReceiptEvent[]=[],seen=new Set<string>();
  for(const observation of observations){
    const {signature,transaction:record,block}=observation;
    assert.ok(!seen.has(signature),'Duplicate transaction observation');seen.add(signature);
    assert.ok(Number.isSafeInteger(record.slot)&&record.slot>deploySlot&&Number.isSafeInteger(record.blockTime)&&record.blockTime===block.blockTime,'Receipt slot/time differs');
    assert.ok(block.signatures.filter(value=>value===signature).length===1,'Receipt missing from its finalized block');
    assert.ok(new PublicKey(block.blockhash).toBase58()===block.blockhash&&Number.isSafeInteger(block.parentSlot)&&block.parentSlot<record.slot,'Invalid receipt block');
    assert.equal(record.transaction[1],'base64');
    const serialized=Buffer.from(record.transaction[0],'base64');assert.equal(serialized.toString('base64'),record.transaction[0]);
    const tx=VersionedTransaction.deserialize(serialized),message=Buffer.from(tx.message.serialize());
    assert.equal(tx.signatures.length,tx.message.header.numRequiredSignatures);
    const staticKeys=tx.message.staticAccountKeys;
    for(let i=0;i<tx.signatures.length;i++)assert.ok(verify(null,message,createPublicKey({format:'der',type:'spki',key:Buffer.concat([
      Buffer.from('302a300506032b6570032100','hex'),staticKeys[i].toBuffer()])}),tx.signatures[i]),'Receipt signature is invalid');
    assert.equal(utils.bytes.bs58.encode(Buffer.from(tx.signatures[0])),signature,'Receipt transaction signature differs');
    // Failed transactions are retained as observations, never counted as payments.
    if(record.meta.err!==null)continue;
    const keys=[...staticKeys,...(record.meta.loadedAddresses?.writable??[]).map(value=>new PublicKey(value)),...(record.meta.loadedAddresses?.readonly??[]).map(value=>new PublicKey(value))];
    for(const group of record.meta.innerInstructions??[]){
      assert.ok(Number.isSafeInteger(group.index)&&group.index>=0&&group.index<tx.message.compiledInstructions.length,'Invalid outer instruction index');
      for(const [index,inner] of group.instructions.entries()){
        assert.ok(Number.isInteger(inner.programIdIndex)&&inner.programIdIndex>=0&&inner.programIdIndex<keys.length,'Invalid CPI program index');
        const raw=Buffer.from(utils.bytes.bs58.decode(inner.data));
        if(keys[inner.programIdIndex].toBase58()!==idl.address||!raw.subarray(0,8).equals(cpiTag))continue;
        assert.ok(Number.isInteger(inner.stackHeight)&&inner.stackHeight!>=2&&inner.stackHeight!<=64,'Missing complete CPI stack height');
        const decoded=coder.events.decode(raw.subarray(8).toString('base64'));assert.ok(decoded,'Unknown retirement CPI event');
        events.push({signature,slot:record.slot,blockhash:block.blockhash,outerInstructionIndex:group.index,innerInstructionIndex:index,
          stackHeight:inner.stackHeight!,name:decoded.name,rawEvent:raw.toString('base64'),data:json(decoded.data)});
      }
    }
  }
  const begun=events.filter(event=>event.name==='LegacyRetirementBegun');assert.equal(begun.length,1,'One begin receipt required');
  assert.equal(Buffer.from(begun[0].data.manifest_sha256).toString('hex'),manifest.onChainManifestSha256,'Another retirement manifest');
  assert.equal(String(begun[0].data.source_slot),String(manifest.sourceSlot));assert.deepEqual(begun[0].data.custody.map(String),manifest.custodyRaw);
  const cleared=events.filter(event=>event.name==='LegacyOwnerCleared');
  assert.equal(cleared.length,manifest.users.length,'Complete owner-clear receipts required');
  assert.deepEqual(cleared.map(event=>event.data.owner).sort(),manifest.users.map(user=>user.owner).sort(),'Owner-clear receipts differ');
  const paid=events.filter(event=>event.name==='LegacyRetirementPaid');assert.equal(paid.length,manifest.users.length+1,'Complete payout receipts required');
  const expected=new Map<string,{owner:string;baseRaw:string;quoteRaw:string;treasury:boolean}>([...manifest.users.map(user=>[user.owner,{...user,treasury:false}] as const),[manifest.treasury.owner,{...manifest.treasury,treasury:true}] as const]);
  assert.equal(expected.size,manifest.users.length+1,'Treasury and beneficiary identities must be distinct');
  for(const event of paid){const row=expected.get(event.data.owner);assert.ok(row,'Unexpected or duplicated beneficiary');
    assert.equal(String(event.data.base),row.baseRaw,'Base payout differs');assert.equal(String(event.data.quote),row.quoteRaw,'Quote payout differs');
    assert.equal(event.data.treasury,row.treasury,'Treasury role differs');expected.delete(event.data.owner);}
  assert.ok(events.every(event=>['LegacyMarketFrozen','LegacyRetirementBegun','LegacyOwnerCleared','LegacyRetirementPaid'].includes(event.name)),'Unknown retirement receipt');
  return {events,observationsSha256:sha256(canonicalJson(observations)),usersPaid:manifest.users.length,treasuryPaid:true};
}
