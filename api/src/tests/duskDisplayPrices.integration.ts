/** Disposable PostgreSQL only: provider observations are always rolled back. */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import pool from '../config/database';
import { loadPinnedProtocol } from '../config/duskProtocol';
import { storeExternalPrices } from '../services/duskExternalPrices';
import { withProviderDisplayPrices } from '../services/duskDisplayPrices';

if (process.env.DUSK_ALLOW_DISPOSABLE_DB_TESTS !== 'true' || !process.env.DATABASE_URL)
  throw new Error('A disposable DATABASE_URL is required');
after(() => pool.end());
const base = 'omfgRBnxHsNJh6YeGbGAmWenNkenzsXyBXm3WDhmeta';
const quote = 'METAwkXcqyXKy1AtsSgJ8JiUHwGCafnZL38n3vYmeta';
const hash = 'b'.repeat(64), at = '2026-11-15T00:00:00.000Z';
const market = () => ({ baseMint: base, quoteMint: quote, baseDecimals: 6, quoteDecimals: 9,
  state: { previewStatus: 'available' }, displayPrices: { observedAt: at, prices: [] } });

test('selects only the latest same-deployment quote already observed by the bank, with exact mint decimals', async () => {
  const client = await pool.connect(), pin = loadPinnedProtocol();
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO dusk_ingestion.protocol_identities(cluster,program_id,idl_hash,protocol_revision)
      VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,[pin.cluster,pin.dusk.programId,pin.dusk.idlCanonicalSha256,pin.revision]);
    const save = (mint: string, decimals: number, seconds: string, priceUsd: string, deployment = hash) =>
      storeExternalPrices(client,[{ mint,decimals,priceUsd,provider: 'jupiter',externalMint: mint,
        sourceTime: `2026-11-14T23:${seconds}.000Z`,observedAt: `2026-11-14T23:${seconds}.000Z` }],deployment);
    await save(base,6,'58:00','0.09'); // Too old.
    await save(base,6,'59:20','0.12');
    await save(base,6,'59:40','0.125');
    await save(base,6,'59:50','9','c'.repeat(64)); // Another deployment.
    await save(quote,9,'59:40','3.1');
    await save(quote,6,'59:50','3000'); // Incorrect mint decimals must not hide the older valid quote.
    await storeExternalPrices(client,[{ mint: base,decimals: 6,priceUsd: '20',provider: 'jupiter',externalMint: base,
      sourceTime: '2026-11-15T00:00:01Z',observedAt: '2026-11-15T00:00:01Z' }],hash);
    const result = await withProviderDisplayPrices(market(),hash,client);
    assert.deepEqual(result.displayPrices.prices.map((row: any) => [row.mint,row.priceUsd]),[[quote,'3.1'],[base,'0.125']]);
    assert.equal((await withProviderDisplayPrices(market(),'d'.repeat(64),client)).displayPrices.prices.length,0);
  } finally { await client.query('ROLLBACK'); client.release(); }
});
