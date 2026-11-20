/** Actual migration/trigger on an isolated schema; no protocol fixtures commit. */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { PoolClient } from 'pg';
import pool from '../config/database';

if (process.env.DUSK_ALLOW_DISPOSABLE_DB_TESTS !== 'true' || !process.env.DATABASE_URL)
  throw new Error('A disposable DATABASE_URL is required');
after(() => pool.end());
const migration = readFileSync(resolve(__dirname,'../../../database/migrations/063_dusk_portfolio_evidence_integrity.sql'),'utf8');
const identity = ['mainnet-beta','11111111111111111111111111111111','a'.repeat(64),'isolated-test'];
async function isolated(work: (schema:string,install:()=>Promise<void>)=>Promise<void>) {
  const schema=`portfolio_bank_test_${randomUUID().replace(/-/g,'')}`;
  await pool.query(`CREATE SCHEMA ${schema};
    CREATE TABLE ${schema}.protocol_identities(cluster text,program_id text,idl_hash text,protocol_revision text,
      PRIMARY KEY(cluster,program_id,idl_hash,protocol_revision));
    CREATE TABLE ${schema}.portfolio_capture_observations(capture_id bigint PRIMARY KEY,
      cluster text NOT NULL,program_id text NOT NULL,idl_hash text NOT NULL,protocol_revision text NOT NULL);
    CREATE TABLE ${schema}.portfolio_account_evidence(capture_id bigint NOT NULL REFERENCES ${schema}.portfolio_capture_observations,
      account text NOT NULL,slot bigint NOT NULL CHECK(slot>=0),basis text NOT NULL,
      blockhash text NOT NULL,state_hash text NOT NULL CHECK(state_hash ~ '^[0-9a-f]{64}$'),
      PRIMARY KEY(capture_id,account,slot,basis,state_hash));
    CREATE INDEX evidence_bank ON ${schema}.portfolio_account_evidence(account,slot,basis)`);
  try {
    await pool.query(`INSERT INTO ${schema}.protocol_identities VALUES($1,$2,$3,$4)`,identity);
    await work(schema,async()=>{ await pool.query(migration.replace(/dusk_ingestion/g,schema)); });
  } finally { await pool.query(`DROP SCHEMA ${schema} CASCADE`); }
}
async function captures(schema:string,count:number) {
  await pool.query(`INSERT INTO ${schema}.portfolio_capture_observations SELECT n,$1,$2,$3,$4 FROM generate_series(1,$5::int) n`,[...identity,count]);
}
async function agreesWithFullScan(schema:string) {
  const keys='cluster,program_id,idl_hash,protocol_revision,account,slot,basis';
  const expected=await pool.query(`SELECT ${keys},count(DISTINCT(blockhash,state_hash))>1 AS conflicted
    FROM ${schema}.portfolio_account_evidence JOIN ${schema}.portfolio_capture_observations USING(capture_id)
    GROUP BY ${keys} ORDER BY ${keys}`);
  const actual=await pool.query(`SELECT ${keys},conflicted FROM ${schema}.portfolio_evidence_banks ORDER BY ${keys}`);
  assert.deepEqual(actual.rows,expected.rows,'every indexed flag must equal the independent original source grouping');
}
const fingerprint=(n:number)=>n.toString(16).padStart(64,'0');
async function evidence(client: Pick<PoolClient,'query'>,schema:string,capture:number,account:string,hash:number,block='block') {
  return client.query(`INSERT INTO ${schema}.portfolio_account_evidence VALUES($1,$2,1,'rpc-account',$3,$4) ON CONFLICT DO NOTHING`,[capture,account,block,fingerprint(hash)]);
}

test('migration backfills exact disagreement flags and batch inserts retain identity and basis boundaries',()=>isolated(async(schema,install)=>{
  await captures(schema,8);
  await evidence(pool,schema,1,'old-conflict',1);
  await evidence(pool,schema,2,'old-conflict',2);
  await evidence(pool,schema,1,'duplicate',3);
  await evidence(pool,schema,2,'duplicate',3);
  await install();
  let rows=await pool.query(`SELECT account,conflicted FROM ${schema}.portfolio_evidence_banks ORDER BY account`);
  assert.deepEqual(rows.rows,[{account:'duplicate',conflicted:false},{account:'old-conflict',conflicted:true}]);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${schema}.portfolio_account_evidence`)).rows[0].n,4);
  await pool.query(`INSERT INTO ${schema}.portfolio_account_evidence VALUES
    (3,'batch',1,'rpc-account','a',$1),(4,'batch',1,'rpc-account','a',$2),
    (5,'different-basis',1,'rpc-account','b',$1),(6,'different-basis',1,'simulation-post-state','c',$2)`,[fingerprint(1),fingerprint(2)]);
  assert.equal((await pool.query(`SELECT conflicted FROM ${schema}.portfolio_evidence_banks WHERE account='batch'`)).rows[0].conflicted,true);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${schema}.portfolio_evidence_banks WHERE account='different-basis' AND NOT conflicted`)).rows[0].n,2);
  await evidence(pool,schema,7,'only-block-changed',1,'a');
  await evidence(pool,schema,8,'only-block-changed',1,'b');
  assert.equal((await pool.query(`SELECT conflicted FROM ${schema}.portfolio_evidence_banks WHERE account='only-block-changed'`)).rows[0].conflicted,true);
  const archive=[...identity.slice(0,3),'archive-test'];
  await pool.query(`INSERT INTO ${schema}.protocol_identities VALUES($1,$2,$3,$4)`,archive);
  await pool.query(`INSERT INTO ${schema}.portfolio_capture_observations VALUES(9,$1,$2,$3,$4)`,archive);
  await evidence(pool,schema,9,'duplicate',99);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${schema}.portfolio_evidence_banks WHERE account='duplicate' AND NOT conflicted`)).rows[0].n,2);
  await evidence(pool,schema,1,'duplicate',3); // ON CONFLICT has an empty transition table.
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${schema}.portfolio_evidence_banks WHERE account='duplicate' AND conflicted`)).rows[0].n,0);
  await assert.rejects(pool.query(`UPDATE ${schema}.portfolio_evidence_banks SET conflicted=false WHERE conflicted`),/FINALIZED_INVARIANT/);
  await assert.rejects(pool.query(`UPDATE ${schema}.portfolio_evidence_banks SET state_hash=$1`,[fingerprint(100)]),/FINALIZED_INVARIANT/);
  await assert.rejects(pool.query(`DELETE FROM ${schema}.portfolio_evidence_banks`),/FINALIZED_INVARIANT/);
  await assert.rejects(pool.query(`TRUNCATE ${schema}.portfolio_evidence_banks`),/FINALIZED_INVARIANT/);
  await agreesWithFullScan(schema);
}));

test('concurrent source inserts serialize the same bank; rollback cannot leak or lose a disagreement',()=>isolated(async(schema,install)=>{
  await captures(schema,2);await install();
  const a=await pool.connect(),b=await pool.connect();
  try {
    await a.query('BEGIN');await b.query('BEGIN');
    const pid=(await b.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await evidence(a,schema,1,'concurrent',1);
    const pending=evidence(b,schema,2,'concurrent',2);
    // Observe the actual database lock instead of relying on a timing threshold.
    let locked=false;const deadline=Date.now()+5000;
    while(Date.now()<deadline) {
      locked=(await pool.query(`SELECT wait_event_type='Lock' AS locked FROM pg_stat_activity WHERE pid=$1`,[pid])).rows[0]?.locked===true;
      if(locked)break;await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert(locked,'second writer must contend on the unique bank key');
    await a.query('COMMIT');await pending;
    assert.equal((await b.query(`SELECT conflicted FROM ${schema}.portfolio_evidence_banks`)).rows[0].conflicted,true);
    assert.equal((await pool.query(`SELECT conflicted FROM ${schema}.portfolio_evidence_banks`)).rows[0].conflicted,false,'uncommitted disagreement is invisible');
    await b.query('ROLLBACK');
    await agreesWithFullScan(schema);
    assert.equal((await pool.query(`SELECT conflicted FROM ${schema}.portfolio_evidence_banks`)).rows[0].conflicted,false);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${schema}.portfolio_account_evidence`)).rows[0].n,1);
    await b.query('BEGIN');await evidence(b,schema,2,'concurrent',2);await b.query('COMMIT');
    assert.equal((await pool.query(`SELECT conflicted FROM ${schema}.portfolio_evidence_banks`)).rows[0].conflicted,true);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${schema}.portfolio_account_evidence`)).rows[0].n,2);
    await agreesWithFullScan(schema);
  } finally { await a.query('ROLLBACK');await b.query('ROLLBACK');a.release();b.release(); }
}));

test('a full production-sized evidence history reads only the partial conflict index',t=>isolated(async(schema,install)=>{
  await captures(schema,20000);
  await pool.query(`INSERT INTO ${schema}.portfolio_account_evidence
    SELECT n,'account-'||i,n*100,'rpc-account','block-'||n,
      encode(sha256(convert_to(n::text||':'||i::text,'UTF8')),'hex')
    FROM generate_series(1,20000) n CROSS JOIN generate_series(1,9) i`);
  const original=`SELECT 1 FROM ${schema}.portfolio_account_evidence e JOIN ${schema}.portfolio_capture_observations o USING(capture_id)
    WHERE cluster=$1 AND program_id=$2 AND idl_hash=$3 AND protocol_revision=$4
    GROUP BY cluster,program_id,idl_hash,protocol_revision,account,slot,basis HAVING count(DISTINCT(blockhash,state_hash))>1 LIMIT 1`;
  let began=performance.now();const before=await pool.query(original,identity),fullScanMs=performance.now()-began;
  await install();await pool.query(`ANALYZE ${schema}.portfolio_evidence_banks`);
  const indexed=`SELECT 1 FROM ${schema}.portfolio_evidence_banks WHERE cluster=$1 AND program_id=$2 AND idl_hash=$3 AND protocol_revision=$4 AND conflicted LIMIT 1`;
  began=performance.now();const after=await pool.query(indexed,identity),indexedMs=performance.now()-began;
  assert.deepEqual(after.rows,before.rows);
  const plan=(await pool.query('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+indexed,identity)).rows[0]['QUERY PLAN'][0];
  assert(JSON.stringify(plan).includes('dusk_portfolio_conflicted_banks'),'healthy read must seek the partial conflict index');
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${schema}.portfolio_evidence_banks`)).rows[0].n,180000);
  t.diagnostic(JSON.stringify({evidenceRows:180000,fullScanMs:Math.round(fullScanMs),indexedMs:Math.round(indexedMs),resultIdentical:true}));
}));
