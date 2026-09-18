import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {BorshCoder,Idl} from '@coral-xyz/anchor';
import {loadProtocolAt,loadPinnedProtocol} from '../config/duskProtocol';
import {StoredPriceCapture,verifyStoredPriceCapture} from '../services/duskPrices';

const root=resolve(__dirname,'../../../protocol/archive/devnet-2026-09-13-9973dea');
const pin=loadProtocolAt(root);
const coder=new BorshCoder(JSON.parse(readFileSync(resolve(root,'idl/dusk.json'),'utf8')) as Idl);
const captures=JSON.parse(readFileSync(resolve(__dirname,'../../src/tests/fixtures/archived-quote-captures.json'),'utf8')).map((row:any)=>({...row,
  slot:String(row.slot),market_slot:String(row.market_slot),capture_id:String(row.capture_id),
  block_time:new Date(row.block_time),observed_at:new Date(row.observed_at),
  raw_market:Buffer.from(row.raw_market,'base64'),raw_preview:Buffer.from(row.raw_preview,'base64'),
})) as StoredPriceCapture[];

test('original market samples decode using their exact archived IDL and saved hashes',()=>{
  assert.deepEqual(captures.map(row=>verifyStoredPriceCapture(row,{pin,coder}).projected.spotPrices.base),['1072868436','1256692288']);
  for(const row of captures) assert.throws(()=>verifyStoredPriceCapture(row),/active protocol identity/);
  assert.notEqual(pin.dusk.idlCanonicalSha256,loadPinnedProtocol().dusk.idlCanonicalSha256);
});
test('archive decoding rejects rewritten source identity or bytes',()=>{
  for(const row of captures) {
    assert.throws(()=>verifyStoredPriceCapture({...row,protocol_revision:loadPinnedProtocol().revision},{pin,coder}),/identity/);
    assert.throws(()=>verifyStoredPriceCapture({...row,content_hash:'0'.repeat(64)},{pin,coder}),/hash mismatch/);
    const changed=Buffer.from(row.raw_preview);changed[changed.length-1]^=1;
    assert.throws(()=>verifyStoredPriceCapture({...row,raw_preview:changed},{pin,coder}),/hash mismatch/);
  }
});


test('the previous hLP release replays original stored observations through its own IDL',()=>{
  const root=resolve(__dirname,'../../../protocol/archive/devnet-2026-09-18-1fa72d3');
  const pin=loadProtocolAt(root);
  const coder=new BorshCoder(JSON.parse(readFileSync(resolve(root,'idl/dusk.json'),'utf8')) as Idl);
  const captures=JSON.parse(readFileSync(resolve(__dirname,'../../src/tests/fixtures/archived-quote-captures-1fa72d3.json'),'utf8'));
  assert.equal(captures.length,2);
  for(const raw of captures) {
    const row={...raw,slot:String(raw.slot),market_slot:String(raw.market_slot),capture_id:String(raw.capture_id),block_time:new Date(raw.block_time),observed_at:new Date(raw.observed_at),raw_market:Buffer.from(raw.raw_market,'base64'),raw_preview:Buffer.from(raw.raw_preview,'base64')};
    assert.ok(BigInt(verifyStoredPriceCapture(row,{pin,coder}).projected.spotPrices.base)>0n);
    assert.throws(()=>verifyStoredPriceCapture(row),/active protocol identity/);
  }
});
