import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import pool from '../config/database';
import { eventHistoryPrices } from '../services/duskEventHistoryPrices';
import { storeExternalPrices } from '../services/duskExternalPrices';
import { fixtureMarket, streamedIdentity, streamedMarket } from './duskStreamedFixtures';

if (process.env.DUSK_ALLOW_DISPOSABLE_DB_TESTS !== 'true' || !process.env.DATABASE_URL)
  throw new Error('A disposable DATABASE_URL is required');
after(() => pool.end());

test('history prices retain prior evidence, bind mints/decimals/deployment, and never apply later quotes',async () => {
  const client = await pool.connect(),hash = 'b'.repeat(64);
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO dusk_ingestion.protocol_identities(cluster,program_id,idl_hash,protocol_revision)
      VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,streamedIdentity);
    await streamedMarket(client);
    const at = '2026-11-15T00:00:00.000Z';
    const row = { event_key: 'event',payload: { market: fixtureMarket.market },block_time: new Date(at) };
    const query = { deploymentIdentitySha256: hash };
    assert.deepEqual((await eventHistoryPrices(client,[row],query)).get('event')?.prices,[]);
    const save = async (time: string,priceUsd: string,deployment = hash,decimals = 9) => storeExternalPrices(client,[{
      mint: fixtureMarket.baseMint,externalMint: fixtureMarket.baseMint,decimals,priceUsd,provider: 'jupiter',sourceTime: time,observedAt: time,
    }],deployment);
    await save('2026-11-14T23:50:00Z','2.5');
    await save('2026-11-15T00:00:01Z','999');
    await save('2026-11-14T23:59:00Z','888','f'.repeat(64));
    await save('2026-11-14T23:59:01Z','777',hash,6);
    const result = (await eventHistoryPrices(client,[row,{ ...row,event_key: 'second' }],query)).get('event')!;
    assert.equal(result.basis,'last-observed-before-event.v1');
    assert.equal(result.asOf,at);
    assert.equal(result.prices.length,1);
    assert.equal(result.prices[0].priceUsd,'2.5');
    assert.equal(result.prices[0].sourceTime,'2026-11-14T23:50:00.000Z');
    assert.equal(result.prices[0].deploymentIdentitySha256,hash);
    assert.equal((await eventHistoryPrices(client,[{ ...row,payload: { market: fixtureMarket.baseMint } }],query)).size,0);
  } finally { await client.query('ROLLBACK');client.release(); }
});
