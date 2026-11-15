import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import pool from '../config/database';
import {readLpPerformance} from '../services/duskLpPerformance';
import {deploymentIdentityFingerprint} from '../services/duskDeploymentService';
import {historyDeploymentFixture} from './duskHistoryDeploymentFixtures';
import {fixtureMarket,key,streamedEvent,streamedIdentity,streamedRelease,useFixtureReferences} from './duskStreamedFixtures';
if(process.env.DUSK_ALLOW_DISPOSABLE_DB_TESTS!=='true'||!process.env.DATABASE_URL) throw new Error('Disposable database opt-in required');
after(()=>pool.end());
useFixtureReferences([{mint:fixtureMarket.baseMint,priceUsd:'2',note:'Dated LP fixture'},{mint:fixtureMarket.quoteMint,priceUsd:'1',note:'Dated LP quote'}]);
test('LP capital is priced from canonical history and reconciled to streamed ownership',async()=>{
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO dusk_ingestion.protocol_identities(cluster,program_id,idl_hash,protocol_revision)
      VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,streamedIdentity);
    await streamedRelease(client,{slot:900_100_500,time:new Date()});
    const registered=(await client.query('SELECT registered_at FROM dusk_ingestion.deployment_intervals WHERE cluster=$1 AND protocol_revision=$2',
      [streamedIdentity[0],streamedIdentity[3]])).rows[0].registered_at as Date;
    const at=(ms:number)=>new Date(registered.getTime()+ms).toISOString(),owner=key(201),m=fixtureMarket;
    await streamedEvent(client,'MarketCreated',{market:m.market,base_mint:m.baseMint,quote_mint:m.quoteMint,
      srlp_mint:m.srlp,base_hlp_mint:m.baseHlp,quote_hlp_mint:m.quoteHlp,base_decimals:'9',quote_decimals:'6',config:{}},900_100_001,at(2));
    const deposit=await streamedEvent(client,'LiquidityAdded',{market:m.market,owner,srlp_amount:'100',base_reserve_credit:'50000000000',quote_reserve_credit:'0'},900_100_010,at(5));
    await new Promise(resolve=>setTimeout(resolve,35));
    await client.query(`UPDATE dusk_ingestion.ingestion_cursors SET updated_at=$1 WHERE cluster=$2 AND protocol_revision=$3 AND stream_name='helius-atlas-ws'`,
      [at(20),streamedIdentity[0],streamedIdentity[3]]);
    const envelope={...historyDeploymentFixture(),sourceSlot:900_100_500,observedAt:at(20)};
    const deployment={...envelope,deploymentIdentitySha256:deploymentIdentityFingerprint(envelope)};
    const balances=[{market:m.market,lpMint:m.srlp,kind:'srlp' as const,amount:'100'}];
    let [result]=await readLpPerformance(owner,balances,deployment,client);
    assert.equal(result.remainingBasisUsd,'100');assert.equal(result.claimedYieldUsd,'0');
    const [earlier]=await readLpPerformance(owner,balances,{...deployment,observedAt:at(4)},client);
    assert.equal(earlier.throughTime,at(4),'a later cursor must not advance the original wallet observation');
    assert.equal(earlier.remainingBasisUsd,null,'a later deposit cannot value an earlier capture');
    await streamedEvent(client,'LpTransferred',{market:m.market,lp_mint:m.srlp,token_kind:'0',source_owner:owner,destination_owner:key(202),amount:'1'},900_100_020,at(10));
    [result]=await readLpPerformance(owner,balances,deployment,client);
    assert.equal(result.remainingBasisUsd,null,'a transfer needs its own acquisition basis');
    await client.query(`DELETE FROM dusk_ingestion.canonical_events WHERE cluster=$1 AND program_id=$2 AND idl_hash=$3 AND protocol_revision=$4 AND event_key=$5`,[...streamedIdentity,deposit.eventKey]);
    [result]=await readLpPerformance(owner,balances,deployment,client);
    assert.equal(result.remainingBasisUsd,null,'an orphaned acquisition cannot remain in the capital ledger');
  } finally {await client.query('ROLLBACK');client.release();}
});
