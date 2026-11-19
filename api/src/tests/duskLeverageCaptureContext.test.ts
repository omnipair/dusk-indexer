import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { resolve } from 'node:path';
import { Connection,PublicKey } from '@solana/web3.js';
import { captureLeverageQuoteBank } from '../services/duskLeverageMaximum';
import type { FrozenLeverageBank,LeverageMaximumInput } from '../services/duskLeverageMaximumInput';
const fixture=()=>JSON.parse(gunzipSync(readFileSync(resolve(__dirname,'../../src/tests/fixtures/leverage-mainnet-layout19-usdv.json.gz'))).toString()) as {input:LeverageMaximumInput;bank:FrozenLeverageBank};
const lag=()=>Object.assign(new Error('Minimum context slot has not been reached'),{code:-32016});
test('a lagging RPC node retries capture without weakening the requested slot',async()=>{
 const f=fixture();let calls=0;
 const rpc={simulateTransaction:async(_tx:unknown,config:{minContextSlot:number;accounts:{addresses:string[]}})=>{
  calls++;assert.equal(config.minContextSlot,f.input.minimumSourceSlot);if(calls===1)throw lag();
  return{context:{slot:f.bank.slot},value:{err:null,accounts:config.accounts.addresses.map(address=>{const a=f.bank.accounts.find(x=>x.address===address)!.account!;return{...a,data:[a.data,'base64'],rentEpoch:Number(a.rentEpoch)}})}};
 }} as unknown as Connection;
 const result=await captureLeverageQuoteBank(f.input,[new PublicKey(f.input.owner)],'EdYBBhu2PU84eNt6r8zPWkaxrxbXVAzVvAz3tR3XveRq',rpc);
 assert.equal(calls,2);assert.equal(result.slot,f.bank.slot);
});
test('the real versioned web3 client wrapped lag error is retried at the same floor',async()=>{
 const f=fixture();let calls=0;
 const rpc=new Connection('https://quote.invalid',{commitment:'confirmed',fetch:async(_url,init)=>{
  calls++;const request=JSON.parse(String(init?.body));assert.equal(request.params[1].minContextSlot,f.input.minimumSourceSlot);
  if(calls===1)return new Response(JSON.stringify({jsonrpc:'2.0',id:request.id,error:{code:-32016,message:'Minimum context slot has not been reached'}}));
  const accounts=request.params[1].accounts.addresses.map((address:string)=>{const a=f.bank.accounts.find(x=>x.address===address)!.account!;return{...a,data:[a.data,'base64'],rentEpoch:Number(a.rentEpoch)}});
  return new Response(JSON.stringify({jsonrpc:'2.0',id:request.id,result:{context:{slot:f.bank.slot},value:{err:null,logs:[],accounts,returnData:null}}}));
 }});
 const result=await captureLeverageQuoteBank(f.input,[new PublicKey(f.input.owner)],'EdYBBhu2PU84eNt6r8zPWkaxrxbXVAzVvAz3tR3XveRq',rpc);
 assert.equal(calls,2);assert.equal(result.slot,f.bank.slot);
});
test('persistent node lag stops after bounded retries and remains unavailable',async()=>{
 const f=fixture();let calls=0;const rpc={simulateTransaction:async()=>{calls++;throw lag()}} as unknown as Connection;
 await assert.rejects(captureLeverageQuoteBank(f.input,[],'EdYBBhu2PU84eNt6r8zPWkaxrxbXVAzVvAz3tR3XveRq',rpc),(e:unknown)=>e instanceof Error&&'status'in e&&e.status===503);
 assert.equal(calls,4);
});
test('unrelated RPC failures are not retried or turned into a bank',async()=>{
 const f=fixture();let calls=0;const rpc={simulateTransaction:async()=>{calls++;throw new Error('RPC denied')}} as unknown as Connection;
 await assert.rejects(captureLeverageQuoteBank(f.input,[],'EdYBBhu2PU84eNt6r8zPWkaxrxbXVAzVvAz3tR3XveRq',rpc),/RPC denied/);assert.equal(calls,1);
});
