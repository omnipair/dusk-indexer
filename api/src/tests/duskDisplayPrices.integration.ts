/** Disposable PostgreSQL only: provider observations are always rolled back. */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import pool from '../config/database';
import { loadPinnedProtocol } from '../config/duskProtocol';
import { storeExternalPrices } from '../services/duskExternalPrices';
import { readProviderPriceObservationBatch,readProviderPriceObservations,withProviderDisplayPrices } from '../services/duskDisplayPrices';

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

test('batched indexed reads exactly match the former reader across cutoffs, ties and excluded evidence',async () => {
  const client = await pool.connect(),pin = loadPinnedProtocol();
  const active = [pin.cluster,pin.dusk.programId,pin.dusk.idlCanonicalSha256,pin.revision];
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO dusk_ingestion.protocol_identities(cluster,program_id,idl_hash,protocol_revision)
      VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,active);
    const save = (mint: string,decimals: number,time: string,priceUsd: string,changes: Record<string,any> = {}) => {
      const { source = `dusk-provider.v1:jupiter:${mint}:${hash}`,observedAt = time,...evidence } = changes;
      return client.query(`INSERT INTO dusk_ingestion.price_observations
        (cluster,program_id,idl_hash,protocol_revision,mint,decimals,source_time,observed_at,price_usd,quality,source,source_evidence)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'external-observation',$10,$11)`,
        [...active,mint,decimals,time,observedAt,priceUsd,source,
          { basis: 'dusk-provider.v1',sourceCluster: 'mainnet-beta',externalMint: mint,deploymentIdentitySha256: hash,...evidence }]);
    };
    await save(base,6,'2026-11-14T23:50:00Z','0.1');
    await save(quote,9,'2026-11-14T23:50:00Z','3');
    await save(base,6,'2026-11-14T23:59:00Z','0.12');
    await save(base,6,'2026-11-14T23:59:00Z','0.125',{ source: `dusk-provider.v1:birdeye:${base}:${hash}` });
    await save(quote,6,'2026-11-14T23:59:01Z','999');
    await save(base,6,'2026-11-14T23:59:02Z','999',{ deploymentIdentitySha256: 'c'.repeat(64) });
    await save(base,6,'2026-11-14T23:59:03Z','999',{ externalMint: quote });
    await save(base,6,'2026-11-14T23:59:04Z','999',{ basis: 'foreign' });
    await save(base,6,'2026-11-14T23:59:05Z','999',{ sourceCluster: 'devnet' });
    await save(base,6,'2026-11-14T23:59:06Z','999',{ source: 'foreign-provider' });
    await save(base,6,'2026-11-14T23:59:07Z','999',{ observedAt: '2026-11-15T00:00:01Z' });
    await save(base,6,'2026-11-15T00:00:02Z','0.13');
    const markets = ['2026-11-14T23:40:00Z','2026-11-14T23:50:00Z','2026-11-15T00:00:00Z','2026-11-15T00:00:02Z']
      .map(observedAt => ({ ...market(),displayPrices: { observedAt } }));
    // Retain the original DISTINCT ON query as an independent economic oracle.
    for (const mode of ['live','historical'] as const) {
      const actual = await readProviderPriceObservationBatch(markets,[hash],client,mode);
      for (const [index,view] of markets.entries()) {
        const expected = await client.query(`SELECT DISTINCT ON (mint)
          observation_id::text AS "observationId",mint,decimals,price_usd::text AS "priceUsd",
          CASE WHEN source LIKE 'dusk-provider.v1:jupiter:%' THEN 'jupiter' ELSE 'birdeye' END AS provider,
          to_char(source_time AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "sourceTime",
          to_char(observed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "observedAt",
          source_evidence->>'deploymentIdentitySha256' AS "deploymentIdentitySha256"
          FROM dusk_ingestion.price_observations WHERE cluster=$1 AND program_id=$2 AND idl_hash=$3 AND protocol_revision=$4
          AND ((mint=$5 AND decimals=$9) OR (mint=$10 AND decimals=$11)) AND quality='external-observation'
          AND (source LIKE 'dusk-provider.v1:jupiter:%' OR source LIKE 'dusk-provider.v1:birdeye:%')
          AND source_evidence->>'basis'='dusk-provider.v1' AND source_evidence->>'sourceCluster'='mainnet-beta'
          AND source_evidence->>'externalMint'=mint AND source_evidence->>'deploymentIdentitySha256'=ANY($6::text[])
          AND source_time<=observed_at AND observed_at<=$7::timestamptz
          AND ($8::int IS NULL OR source_time>=$7::timestamptz-($8::int*interval '1 millisecond'))
          ORDER BY mint,source_time DESC,observation_id DESC`,
          [...active,base,[hash],view.displayPrices.observedAt,mode === 'live' ? 90_000 : null,6,quote,9]);
        assert.deepEqual(actual[index],expected.rows,`${mode} ${view.displayPrices.observedAt}`);
        assert.deepEqual(await readProviderPriceObservations(view,[hash],client,mode),expected.rows);
      }
    }
    assert.deepEqual(await readProviderPriceObservationBatch([],[],client),[]);
    assert.deepEqual(await readProviderPriceObservationBatch([{ ...market(),state: { previewStatus: 'unavailable' } }],[],client),[[]]);
    await assert.rejects(readProviderPriceObservationBatch(markets,[],client),/Invalid provider deployment/);
  } finally { await client.query('ROLLBACK');client.release(); }
});
