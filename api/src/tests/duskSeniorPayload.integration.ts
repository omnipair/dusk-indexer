/** Disposable PostgreSQL only: compare with the original compatibility function. */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pool from '../config/database';

if (process.env.DUSK_ALLOW_DISPOSABLE_DB_TESTS !== 'true' || !process.env.DATABASE_URL)
  throw new Error('Set DUSK_ALLOW_DISPOSABLE_DB_TESTS=true and a disposable DATABASE_URL');
after(() => pool.end());

test('streamed payload fast path is identical to the original converter for modern and legacy trees',async () => {
  const original = readFileSync(resolve(__dirname,'../../../database/migrations/052_dusk_senior_lp_names.sql'),'utf8')
    .match(/CREATE FUNCTION dusk_ingestion\.senior_lp_payload\(value jsonb\) RETURNS jsonb\s+LANGUAGE plpgsql IMMUTABLE STRICT AS \$\$([\s\S]*?)\$\$;/)?.[1];
  assert.ok(original);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`CREATE FUNCTION pg_temp.original_senior_payload(value jsonb) RETURNS jsonb
      LANGUAGE plpgsql IMMUTABLE STRICT AS $$${original.split('dusk_ingestion.senior_lp_payload').join('pg_temp.original_senior_payload')}$$`);
    const fixtures = [null,true,false,0,123,'ylp is a string value, not a key',[],{},
      { market: 'modern',srlp_supply: '18446744073709551615',base: { spot_price_nad: '123',srlp: ['one',null,3] } },
      { ylp: 1,Ylp: 2,YLP: 3,nested: [{ ylp_mint: 'mint',string: 'ylp' },{ ylp_ylp: 4 }] },
      { ylp_supply: '1',srlp_mint: 'mint',items: [[{ YlpSupply: 2 }],null,{},[]] },
      JSON.parse('{"y\\u006cp_mint":"unicode spelling","not_a_key":"\\u0079lp"}'),
      Object.fromEntries(Array.from({ length: 128 },(_,i) => [`modern_${i}`,{ srlp: String(i),values: [i,true,null] }])),
    ];
    for (const value of fixtures) {
      const result = await client.query(`SELECT dusk_ingestion.senior_lp_payload($1::jsonb) AS actual,
        pg_temp.original_senior_payload($1::jsonb) AS original`,[JSON.stringify(value)]);
      assert.deepEqual(result.rows[0].actual,result.rows[0].original);
    }
    const nulls = await client.query(`SELECT dusk_ingestion.senior_lp_payload(NULL) IS NULL AS sql_null,
      jsonb_typeof(dusk_ingestion.senior_lp_payload('null'::jsonb)) AS json_null`);
    assert.deepEqual(nulls.rows[0],{ sql_null: true,json_null: 'null' });
    for (const value of [{ ylp: 1,srlp: 2 },{ items: [{ YlpMint: 'a',SrlpMint: 'b' }] },
      { ylp_ylp: 1,srlp_srlp: 2 }]) {
      for (const name of ['dusk_ingestion.senior_lp_payload','pg_temp.original_senior_payload']) {
        await client.query('SAVEPOINT collision');
        await assert.rejects(client.query(`SELECT ${name}($1::jsonb)`,[JSON.stringify(value)]),/Conflicting senior LP payload fields/);
        await client.query('ROLLBACK TO SAVEPOINT collision');
      }
    }
  } finally { await client.query('ROLLBACK'); client.release(); }
});
