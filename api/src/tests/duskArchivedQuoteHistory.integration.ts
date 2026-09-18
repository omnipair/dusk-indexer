import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'fs';
import {resolve} from 'path';
import {BorshCoder,Idl} from '@coral-xyz/anchor';
import pool from '../config/database';
import {loadProtocolAt,loadPinnedProtocol} from '../config/duskProtocol';
import {readArchivedQuoteHistory,ARCHIVED_QUOTE_REVISION,PREVIOUS_QUOTE_REVISION} from '../services/duskArchivedQuoteHistory';
import {readQuoteHistory} from '../services/duskQuoteHistory';
import {verifyStoredPriceCapture,StoredPriceCapture} from '../services/duskPrices';

if(process.env.DUSK_ALLOW_DISPOSABLE_DB_TESTS!=='true'||!process.env.DATABASE_URL) throw new Error('Disposable database required');
after(()=>pool.end());
for (const [revision, suffix] of [[ARCHIVED_QUOTE_REVISION, ''], [PREVIOUS_QUOTE_REVISION, '-1fa72d3']]) {
const root=resolve(__dirname,'../../../protocol/archive',revision),pin=loadProtocolAt(root);
const coder=new BorshCoder(JSON.parse(readFileSync(resolve(root,'idl/dusk.json'),'utf8')) as Idl);
const fixtures=(name:string)=>JSON.parse(readFileSync(resolve(__dirname,'../../src/tests/fixtures',name),'utf8'));
const envelopes=fixtures(`archived-quote-deployments${suffix}.json`);

test(`${revision}: archived candles retain their original evidence and remain excluded from active history`,async()=>{
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('INSERT INTO dusk_ingestion.protocol_identities(cluster,program_id,idl_hash,protocol_revision) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[pin.cluster,pin.dusk.programId,pin.dusk.idlCanonicalSha256,pin.revision]);
    for(const envelope of envelopes) await client.query('INSERT INTO dusk_ingestion.capture_deployments(cluster,program_id,idl_hash,protocol_revision,deployment_identity_sha256,envelope) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',[pin.cluster,pin.dusk.programId,pin.dusk.idlCanonicalSha256,pin.revision,envelope.deploymentIdentitySha256,envelope]);
    for(const raw of fixtures(`archived-quote-captures${suffix}.json`)) {
      const row={...raw,slot:String(raw.slot),market_slot:String(raw.market_slot),capture_id:String(raw.capture_id),block_time:new Date(raw.block_time),observed_at:new Date(raw.observed_at),raw_market:Buffer.from(raw.raw_market,'base64'),raw_preview:Buffer.from(raw.raw_preview,'base64')} as StoredPriceCapture;
      const {projected}=verifyStoredPriceCapture(row,{pin,coder});
      const keys=Object.keys(row).filter(k=>k!=='capture_id');
      const inserted=await client.query(`INSERT INTO dusk_ingestion.price_capture_observations(${keys.join(',')}) VALUES(${keys.map((_,i)=>`$${i+1}`).join(',')}) RETURNING capture_id`,keys.map(k=>(row as any)[k]));
      const b=projected.bound;
      await client.query('INSERT INTO dusk_ingestion.market_quote_projections(capture_id,base_mint,quote_mint,base_decimals,quote_decimals,base_spot_price_nad,quote_spot_price_nad) VALUES($1,$2,$3,$4,$5,$6,$7)',[inserted.rows[0].capture_id,b.baseMint,b.quoteMint,b.baseDecimals,b.quoteDecimals,projected.spotPrices.base,projected.spotPrices.quote]);
    }
    const query={market:'7Rjrf8i81hZihsuFdPfzTaP6SiQ3JEmQs7Hfg7YNjkNm',side:'base' as const,since:'2026-09-14T00:00:00Z',until:'2026-09-18T11:28:00Z',resolutionSeconds:900,deploymentIdentitySha256:envelopes[0].deploymentIdentitySha256};
    const archived=await readArchivedQuoteHistory(client,query,revision);
    assert.equal(archived.history.coverage.protocolRevision,pin.revision);
    assert.ok(archived.history.candles.length > 0);
    if (!suffix) {
      assert.equal(archived.history.candles.length,2);
      assert.deepEqual(archived.history.candles.map(c=>c.close.price),['1.072868436','1.256692288']);
      assert.ok(Number(archived.history.coverage.lastSourceSlot) < 499930981);
    } else {
      assert.ok(Number(archived.history.coverage.firstSourceSlot) > 499930981);
    }
    assert.ok(Number(archived.history.coverage.lastSourceSlot)<loadPinnedProtocol().dusk.deployment.deploySlot);
    assert.equal((await readQuoteHistory(client,query)).candles.length,0);
    await assert.rejects(readArchivedQuoteHistory(client,query,'unknown'),/Unsupported/);
  } finally {await client.query('ROLLBACK');client.release();}
});

}
