import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import pool from '../config/database';
import {readLeverageCashFlows} from '../services/duskLeverageCashFlows';
import {fixtureMarket,key,streamedEvent,streamedRelease,streamedIdentity} from './duskStreamedFixtures';
if (process.env.DUSK_ALLOW_DISPOSABLE_DB_TESTS!=='true' || !process.env.DATABASE_URL)
  throw new Error('Disposable database opt-in required');
after(()=>pool.end());

test('canonical contributions reconcile to the account and roll back with a rejected observation',async()=>{
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO dusk_ingestion.protocol_identities(cluster,program_id,idl_hash,protocol_revision)
      VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,streamedIdentity);
    await streamedRelease(client,{slot:900_100_200,time:new Date()});
    const owner=key(201),address=key(210),market=fixtureMarket.market;
    const base={owner,position:address,market,debt_asset_mint:key(206),collateral_asset_mint:key(207),
      margin_amount:'100',collateral_amount:'300',debt_shares:'200'};
    await streamedEvent(client,'LeveragePositionOpened',base,900_100_100);
    const added=await streamedEvent(client,'LeveragePositionUpdated',{...base,owner_debit:'50',owner_credit:'0',debt_shares:'150'},900_100_110);
    const ref={address,market,openedSlot:900_100_100,marginRaw:'100',collateralRaw:'300',debtShares:'150'};
    let [flow]=await readLeverageCashFlows(owner,[ref],900_100_100,client);
    assert.equal(flow.status,'available');
    assert.equal('contributedRaw' in flow && flow.contributedRaw,'150');
    await client.query(`DELETE FROM dusk_ingestion.canonical_events WHERE cluster=$1 AND program_id=$2 AND idl_hash=$3
      AND protocol_revision=$4 AND event_key=$5`,[...streamedIdentity,added.eventKey]);
    [flow]=await readLeverageCashFlows(owner,[ref],900_100_100,client);
    assert.equal(flow.status,'unavailable','a missing matching post-state cannot publish a stale basis');
    [flow]=await readLeverageCashFlows(owner,[{...ref,debtShares:'200'}],900_100_100,client);
    assert.equal('contributedRaw' in flow && flow.contributedRaw,'100','orphaned update never remains in PnL');
    [flow]=await readLeverageCashFlows(owner,[ref],900_100_201,client);
    assert.equal(flow.status,'unavailable','a lagging stream never invents cash flows');
  } finally {await client.query('ROLLBACK');client.release();}
});
