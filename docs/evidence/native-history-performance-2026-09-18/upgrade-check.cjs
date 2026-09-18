// Run from the repository root, against an explicitly disposable database.
// seed: schema through 041; verify: apply 042 with the normal migration runner.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {createRequire} = require('node:module');
if (process.env.DUSK_ALLOW_DISPOSABLE_DB_TESTS !== 'true' || !process.env.DATABASE_URL) throw new Error('Disposable database required');
const fromApi = createRequire(path.resolve('api/dist/services/duskEventHistory.js'));
const pool = fromApi('../config/database').default;
const pin = fromApi('../config/duskProtocol').loadPinnedProtocol();
const identity = [pin.cluster,pin.dusk.programId,pin.dusk.idlCanonicalSha256,pin.revision];
const other = [...identity.slice(0,3),pin.revision+'-upgrade-conflict-fixture'];
const market = 'So11111111111111111111111111111111111111112';
const query = {version:2,market,until:'2026-09-02T00:00:00Z',limit:10,deploymentIdentitySha256:'a'.repeat(64)};
async function insert(active,bank) {
  await pool.query(`INSERT INTO dusk_ingestion.protocol_identities(cluster,program_id,idl_hash,protocol_revision) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,active);
  const key=[...active,'7'.repeat(88),'1.2','0'].join('|');
  const row=(await pool.query(`INSERT INTO dusk_ingestion.event_observations
    (cluster,program_id,idl_hash,protocol_revision,event_key,transaction_signature,instruction_path,event_ordinal,slot,blockhash,commitment,event_name,payload_hash,decoded_payload,source)
    VALUES($1,$2,$3,$4,$5,$6,ARRAY[1,2],0,$7,$8,'finalized','HlpOpened',$9,$10,'migration-upgrade-fixture') RETURNING observation_id`,
    [...active,key,'7'.repeat(88),pin.historyFirstSlot+1,bank,'a'.repeat(64),JSON.stringify({market,owner:market,amount:'9007199254740993'})])).rows[0];
  return {key,id:row.observation_id};
}
async function main() {
  if (process.argv[2]==='seed') {
    const row=await insert(identity,'original-finalized-bank');
    await pool.query(`INSERT INTO dusk_ingestion.canonical_events(cluster,program_id,idl_hash,protocol_revision,event_key,observation_id,commitment) VALUES($1,$2,$3,$4,$5,$6,'finalized')`,[...identity,row.key,row.id]);
    await pool.query(`INSERT INTO dusk_ingestion.event_stream(time,cluster,program_id,event_name,market,transaction_signature,event_key,slot,payload,idl_hash,protocol_revision)
      SELECT '2026-09-01T00:00:10Z',cluster,program_id,event_name,decoded_payload->>'market',transaction_signature,event_key,slot,decoded_payload,idl_hash,protocol_revision FROM dusk_ingestion.event_observations WHERE observation_id=$1`,[row.id]);
    await insert(other,'first-finalized-bank');await insert(other,'contradictory-finalized-bank');
    const ts=fromApi('typescript'),compiled=ts.transpileModule(fs.readFileSync(process.env.BENCH_BASELINE_TS,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,esModuleInterop:true}});
    const baseline={exports:{}};
    new Function('require','module','exports',compiled.outputText)(fromApi,baseline,baseline.exports);
    const client=await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const result=await baseline.exports.readEventHistory(client,query);
      fs.writeFileSync(process.env.UPGRADE_BASELINE_JSON,JSON.stringify(result));
      await client.query('COMMIT');
    } finally {client.release();}
    console.log('Seeded original history and a pre-existing finalized conflict.');
  } else if (process.argv[2]==='verify') {
    const {listEventHistory,eventHistoryState}=fromApi('./duskEventHistory');
    assert.deepEqual(await listEventHistory(query),JSON.parse(fs.readFileSync(process.env.UPGRADE_BASELINE_JSON,'utf8')));
    const client=await pool.connect();
    try {await assert.rejects(eventHistoryState(client,other),/FINALIZED_INVARIANT/);} finally {client.release();}
    console.log('PASS: migration preserved the original page and backfilled the existing conflict halt.');
  } else throw new Error('Use seed or verify');
}
main().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>pool.end());
