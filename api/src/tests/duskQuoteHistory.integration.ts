import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { PoolClient } from 'pg';
import pool from '../config/database';
import { loadPinnedProtocol } from '../config/duskProtocol';
import { projectPriceCapture, projectPriceCaptureBatch, storePriceCapture } from '../services/duskPrices';
import { readQuoteHistory } from '../services/duskQuoteHistory';
import { priceFixture } from './duskPriceFixtures';

if (process.env.DUSK_ALLOW_DISPOSABLE_DB_TESTS !== 'true' || !process.env.DATABASE_URL)
  throw new Error('A disposable DATABASE_URL is required');
after(() => pool.end());
const pin = loadPinnedProtocol(),identity = [pin.cluster,pin.dusk.programId,pin.dusk.idlCanonicalSha256,pin.revision];
const query = { market: priceFixture().source().market,side: 'base' as const,since: '2026-09-02T00:00:00Z',
  until: '2026-09-02T00:03:00Z',resolutionSeconds: 60,deploymentIdentitySha256: 'b'.repeat(64) };
async function transaction(work: (client: PoolClient) => Promise<void>) {
  const client = await pool.connect();
  try { await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await client.query(`INSERT INTO dusk_ingestion.protocol_identities(cluster,program_id,idl_hash,protocol_revision)
      VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,identity); await work(client); }
  finally { await client.query('ROLLBACK'); client.release(); }
}
async function source(client: PoolClient,slotOffset: number,seconds: number,nad: bigint,
  options: { project?: boolean; identity?: string; price?: string; inverse?: bigint } = {}) {
  const fixture = priceFixture({ references: options.price !== undefined,price: options.price,quoteNad: nad,inverseNad: options.inverse });
  const row = fixture.source(pin.historyFirstSlot+100+slotOffset);
  row.blockTime = new Date(Date.parse(query.since)+seconds*1000).toISOString();
  row.observedAt = new Date(Date.parse(row.blockTime)+1000).toISOString();
  row.deploymentIdentitySha256 = options.identity ?? query.deploymentIdentitySha256;
  const id = await storePriceCapture(client,row);
  if (options.project !== false) await projectPriceCapture(client,id);
  return id;
}
test('unpriced markets have exact curve candles with slot-ordered same-second samples and visible gaps',() => transaction(async client => {
  const close = await source(client,3,10,3_000_000_000n);
  const open = await source(client,1,10,2_500_000_000n);
  const high = await source(client,2,10,9_000_000_000n);
  await source(client,4,120,1n);
  await source(client,5,180,5_000_000_000n); // Exclusive upper boundary.
  const result = await readQuoteHistory(client,query);
  assert.equal(result.candles.length,2);
  assert.equal(result.candles[0].time,Date.parse(query.since)/1000);
  assert.equal(result.candles[1].time,Date.parse(query.since)/1000+120);
  assert.equal(result.candles[0].open.captureId,open);
  assert.equal(result.candles[0].close.captureId,close);
  assert.equal(result.candles[0].high.captureId,high);
  assert.equal(result.candles[0].open.time,'2026-09-02T00:00:10.000Z');
  assert.equal(result.candles[0].close.sourceSlot,String(pin.historyFirstSlot+103));
  assert.equal(result.candles[0].low.price,'2.5');
  assert.equal(result.candles[1].close.price,'0.000000001');
  assert.deepEqual([result.binding?.baseDecimals,result.binding?.quoteDecimals],[9,6]);
  assert.equal(result.coverage.samples,'4');
  assert.equal(result.coverage.historyRangeComplete,false);
  assert.equal(result.coverage.tradeOhlcAvailable,false);
  assert.equal(result.coverage.gapsFilled,false);
}));
test('same-bank captures with different USD reference policies count as one quote sample',() => transaction(async client => {
  await source(client,1,10,2_500_000_000n,{ price: '1' });
  await source(client,1,10,2_500_000_000n,{ price: '2' });
  const result = await readQuoteHistory(client,query);
  assert.equal(result.coverage.captures,'2');
  assert.equal(result.coverage.samples,'1');
  assert.equal(result.candles[0].samples,'1');
  assert.equal(result.candles[0].open.price,'2.5');
}));
test('the other direction uses its own program quote and zero quotes remain unavailable',() => transaction(async client => {
  await source(client,1,10,2_500_000_000n,{ inverse: 399_999_999n });
  await source(client,2,120,2_500_000_000n);
  const result = await readQuoteHistory(client,{ ...query,side: 'quote' });
  assert.equal(result.candles.length,1);
  assert.equal(result.candles[0].close.price,'0.399999999');
  assert.equal(result.coverage.unavailableSamples,'1');
  assert.equal(result.coverage.samples,'2');
}));
test('deployment changes isolate saved quotes and pending projections cannot claim complete history',() => transaction(async client => {
  await source(client,1,10,2_500_000_000n,{ identity: 'c'.repeat(64) });
  const id = await source(client,2,120,2_500_000_000n,{ project: false });
  const before = await readQuoteHistory(client,query);
  assert.equal(before.candles.length,0); assert.equal(before.binding,null);
  assert.equal(before.coverage.pendingCaptures,'1'); assert.equal(before.coverage.projectionComplete,false);
  assert.equal(before.coverage.captures,'1');
  await projectPriceCapture(client,id);
  const after = await readQuoteHistory(client,query);
  assert.equal(after.candles.length,1); assert.equal(after.coverage.projectionComplete,true);
  assert.notEqual(after.selectionHash,before.selectionHash);
  assert.equal((await readQuoteHistory(client,{ ...query,deploymentIdentitySha256:'d'.repeat(64) })).coverage.captures,'0');
}));
test('existing completed USD captures acquire quote projections through the normal replay worker',() => transaction(async client => {
  const id = await source(client,1,10,2_500_000_000n,{ project: false });
  await client.query('INSERT INTO dusk_ingestion.price_capture_projections(capture_id,price_count) VALUES($1,0)',[id]);
  await projectPriceCaptureBatch(client);
  assert.equal((await readQuoteHistory(client,query)).candles[0].close.price,'2.5');
  await client.query('SAVEPOINT immutable_quote');
  await assert.rejects(client.query('UPDATE dusk_ingestion.market_quote_projections SET base_spot_price_nad=1 WHERE capture_id=$1',[id]),/FINALIZED_INVARIANT/);
  await client.query('ROLLBACK TO SAVEPOINT immutable_quote');
}));
test('contradictory banks halt quote history even if the conflict is outside the requested window',() => transaction(async client => {
  await source(client,1,10,2_500_000_000n);
  await source(client,1,10,3_000_000_000n,{ project: false });
  await assert.rejects(readQuoteHistory(client,{ ...query,since:'2026-09-02T00:02:00Z' }),/FINALIZED_INVARIANT/);
}));
test('a bank cannot move between candle buckets when another reference policy captures it',() => transaction(async client => {
  await source(client,1,10,2_500_000_000n,{ price:'1' });
  await source(client,1,70,2_500_000_000n,{ price:'2',project:false });
  await assert.rejects(readQuoteHistory(client,query),/FINALIZED_INVARIANT/);
}));
test('a forged materialized candle witness is rejected against its saved Borsh preview',() => transaction(async client => {
  const id = await source(client,1,10,2_500_000_000n,{ project: false });
  const f = priceFixture();
  await client.query(`INSERT INTO dusk_ingestion.market_quote_projections
    (capture_id,base_mint,quote_mint,base_decimals,quote_decimals,base_spot_price_nad,quote_spot_price_nad)
    VALUES($1,$2,$3,9,6,1,0)`,[id,f.baseMint,f.quoteMint]);
  await assert.rejects(readQuoteHistory(client,query),/FINALIZED_INVARIANT/);
  await assert.rejects(projectPriceCapture(client,id),/FINALIZED_INVARIANT/);
}));
