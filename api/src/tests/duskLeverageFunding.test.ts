import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { loadProtocolAt } from '../config/duskProtocol';
import { FrozenLeverageBank,LeverageMaximumInput,NativeLeverageBalanceRejection,NativeLeverageRejection,quoteFrozenLeverageEntry,quoteRuntimeBytes,searchFrozenLeverageSize } from '../services/duskLeverageMaximumEngine';
import { runLeverageMaximumProcess } from '../services/duskLeverageMaximum';
const root=resolve(__dirname,'../../../protocol');
const pin=loadProtocolAt(root),idl=JSON.parse(readFileSync(resolve(root,'idl/dusk.json'),'utf8'));
const fixture=()=>JSON.parse(gunzipSync(readFileSync(resolve(__dirname,'../../src/tests/fixtures/leverage-mainnet-layout19-usdv.json.gz'))).toString()) as {input:LeverageMaximumInput;bank:FrozenLeverageBank;capture:{protocolRevision:string;transactionsSent:number}};
const binary=()=>quoteRuntimeBytes(pin.dusk.programId,pin.dusk.binarySha256,resolve(root,'quote-runtime'));
test('the actual layout-19 USDv bank reports wallet funding separately from market capacity',()=>{
 const f=fixture();assert.equal(f.capture.protocolRevision,pin.revision);assert.equal(f.capture.transactionsSent,0);
 const original=createHash('sha256').update(JSON.stringify(f.bank)).digest('hex');
 assert.throws(()=>quoteFrozenLeverageEntry(f.input,f.bank,idl,binary(),'35000','4000000'),(e:unknown)=>e instanceof NativeLeverageBalanceRejection&&!(e instanceof NativeLeverageRejection));
 assert.throws(()=>searchFrozenLeverageSize(f.input,f.bank,idl,binary()),NativeLeverageBalanceRejection);
 assert.equal(original,createHash('sha256').update(JSON.stringify(f.bank)).digest('hex'));
});
test('a small requested size still converges when its initial margin estimate exceeds wallet funding',()=>{
 const f=fixture(),input={...f.input,size:{...f.input.size!,amount:'10000000'}};
 const result=searchFrozenLeverageSize(input,f.bank,idl,binary());
 assert.equal(result.multiplierBps,'35000');assert.ok(BigInt(result.marginAmount)<987875n);assert.ok(BigInt(result.sizeAmount)>=10000000n);
 assert.ok(quoteFrozenLeverageEntry(input,f.bank,idl,binary(),'35000',String(BigInt(result.marginAmount)-1n)).collateral<10000000n);
});
test('the isolated evaluator preserves the balance outcome and never returns a feasible quote',async()=>{
 const f=fixture();const result=await runLeverageMaximumProcess(f.input,f.bank,idl,pin.dusk.programId,pin.dusk.binarySha256);
 assert.deepEqual(result,{kind:'balance',rejection:'InsufficientBalance'});
});
