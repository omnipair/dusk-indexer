/** Disposable PostgreSQL only: every event fixture rolls back. */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { PoolClient } from 'pg';
import pool from '../config/database';
import { readObservedPriceHistory } from '../services/duskObservedPrices';
import { key, observedMarket, streamedIdentity, streamedSwapSnapshot, useFixtureReferences } from './duskStreamedFixtures';

if (process.env.DUSK_ALLOW_DISPOSABLE_DB_TESTS !== 'true' || !process.env.DATABASE_URL)
  throw new Error('A disposable DATABASE_URL is required');
after(() => pool.end());
useFixtureReferences();
async function transaction(work: (client: PoolClient) => Promise<void>) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO dusk_ingestion.protocol_identities(cluster,program_id,idl_hash,protocol_revision)
      VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,streamedIdentity);
    await work(client);
  } finally { await client.query('ROLLBACK'); client.release(); }
}
const query = (mint: string,options: Partial<{ at: string; maxAgeSeconds: number; market: string; offset: number }> = {}) =>
  ({ mint,at: '2026-09-02T00:10:00Z',maxAgeSeconds: 3600,limit: 50,offset: 0,...options });

test('observed prices derive each side from the program quote and the dated reference policy',() => transaction(async client => {
  await streamedSwapSnapshot(client,{ slot: 900_500_000,time: '2026-09-02T00:00:00Z',baseSpotNad: 2_500_000_000n });
  await streamedSwapSnapshot(client,{ slot: 900_500_010,time: '2026-09-02T00:05:00Z',baseSpotNad: 3_000_000_000n });
  const base = await readObservedPriceHistory(client,query(observedMarket.baseMint));
  assert.deepEqual(base.observations.map(row => [row.priceUsd,row.quality,row.evidence.sourceSlot]),
    [['3','derived-reference','900500010'],['2.5','derived-reference','900500000']]);
  assert.equal(base.observations[0].provenance.commitment,'confirmed');
  assert.equal(base.observations[0].evidence.basis,'market-observed.v1');
  const quote = await readObservedPriceHistory(client,query(observedMarket.quoteMint));
  assert.deepEqual(quote.observations.map(row => [row.priceUsd,row.quality]),[['1','configured-reference'],['1','configured-reference']]);
  assert.equal(base.pagination.total,2);
  assert.equal((await readObservedPriceHistory(client,query(observedMarket.baseMint,{ offset: 1 }))).observations[0].priceUsd,'2.5');
}));

test('old, future, unreferenced and other-market observations give no price',() => transaction(async client => {
  await streamedSwapSnapshot(client,{ slot: 900_500_020,time: '2026-09-01T22:00:00Z' });
  await streamedSwapSnapshot(client,{ slot: 900_500_021,time: '2026-09-02T00:20:00Z' });
  assert.equal((await readObservedPriceHistory(client,query(observedMarket.baseMint))).observations.length,0);
  await streamedSwapSnapshot(client,{ slot: 900_500_022,time: '2026-09-02T00:00:00Z',baseMint: key(160),quoteMint: key(161),market: key(162) });
  const unreferenced = await readObservedPriceHistory(client,query(key(160)));
  assert.equal(unreferenced.observations.length,0); assert.equal(unreferenced.coverage.available,false);
  assert.equal((await readObservedPriceHistory(client,query(key(160),{ market: observedMarket.market }))).pagination.total,0);
}));
