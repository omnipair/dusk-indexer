import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { BN } from '@coral-xyz/anchor';
import { PoolClient } from 'pg';
import pool from '../config/database';
import { loadPinnedProtocol } from '../config/duskProtocol';
import { nativeFields } from '../services/duskPortfolioMath';
import { projectYieldCheckpoint, storeYieldCheckpointSource } from '../services/duskYieldCheckpoints';
import { storePriceCapture } from '../services/duskPrices';
import { readYieldRates } from '../services/duskYieldRates';
import { checkpointFixture, Q64 } from './duskYieldCheckpointFixtures';
import { storeCaptureDeployment } from '../services/duskHistoryDeployment';
import { historyDeploymentFixture } from './duskHistoryDeploymentFixtures';
import { priceFixture } from './duskPriceFixtures';

if (process.env.DUSK_ALLOW_DISPOSABLE_DB_TESTS !== 'true' || !process.env.DATABASE_URL)
  throw new Error('A disposable DATABASE_URL is required');
after(() => pool.end());
const pin=loadPinnedProtocol(),active=[pin.cluster,pin.dusk.programId,pin.dusk.idlCanonicalSha256,pin.revision];
const query={since:'2026-09-01T01:00:00Z',until:'2026-09-02T01:00:00Z',deploymentIdentitySha256:'1'.repeat(64)};

async function transaction(work:(client:PoolClient)=>Promise<void>) {
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO dusk_ingestion.protocol_identities(cluster,program_id,idl_hash,protocol_revision)
      VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,active);
    await work(client);
  } finally {await client.query('ROLLBACK');client.release();}
}
async function seed(client:PoolClient,options:{prices?:boolean;start?:boolean;deployment?:string}={}) {
  const fixture=checkpointFixture();
  fixture.market.version=1;
  for (const [name,reserve] of [['base','100000000000'],['quote','100000000']] as const) {
    const side=nativeFields(fixture.market[`${name}_side`]);
    nativeFields(side.reserves).live_reserve=new BN(reserve);
    nativeFields(side.shares).ylp_supply=new BN(1000000);
  }
  const capture=async(slot:number,time:string) => {
    const source={...fixture.source(slot),blockTime:time,deploymentIdentitySha256:options.deployment ?? query.deploymentIdentitySha256};
    const id=await storeYieldCheckpointSource(client,source);
    await projectYieldCheckpoint(client,id);
    if (options.prices !== false) {
      const price={...priceFixture({quoteNad:1000000000n}).source(slot-1),
        blockTime:new Date(Date.parse(time)-1000).toISOString(),observedAt:time,
        deploymentIdentitySha256:source.deploymentIdentitySha256};
      await storePriceCapture(client,price);
    }
    return source;
  };
  const start=options.start === false ? null : await capture(900000010,query.since);
  nativeFields(nativeFields(fixture.market.base_side).fees).swap_fee_growth_index_q64=new BN((4n*Q64).toString());
  nativeFields(nativeFields(fixture.market.quote_side).fees).interest_growth_index_q64=new BN((2n*Q64+Q64/2n).toString());
  const end=await capture(900200010,query.until);
  return {fixture,start,end};
}

test('yield rates select committed snapshots and prior-bank prices without publishing owner records',()=>transaction(async client=>{
  const {fixture}=await seed(client);
  const data=await readYieldRates(client,query);
  assert.equal(data.markets.length,1);
  const row=data.markets[0];
  assert.equal(row.rates.swapRatePct,'0.1825');
  assert.equal(row.rates.interestRatePct,'91.25');
  assert.equal(row.rates.claimableRatePct,'91.4325');
  assert.equal(row.provenance.startSlot,'900000010');
  assert.equal(row.provenance.initialPrice?.sourceSlot,'900000009');
  assert.equal(data.coverage.fullApyAvailable,false);
  assert.equal(JSON.stringify(data).includes(fixture.owner),false);
  assert.equal(JSON.stringify(data).includes(fixture.yieldAddress),false);
  assert.equal(data.coverage.selectionHash,(await readYieldRates(client,query)).coverage.selectionHash);
}));

test('unpriced growth retains token index deltas without a fabricated USD rate',()=>transaction(async client=>{
  await seed(client,{prices:false});
  const data=await readYieldRates(client,query);
  assert.equal(data.markets.length,1);
  assert.equal(data.markets[0].rates.claimableRatePct,null);
  assert.equal(data.markets[0].rates.missingMints.length,2);
  assert.equal(data.markets[0].rates.deltas[0].swapIndexDeltaQ64,Q64.toString());
}));

test('one-sided, stale, cross-deployment and different-market windows remain unmeasured',()=>transaction(async client=>{
  const {end}=await seed(client,{start:false});
  assert.equal((await readYieldRates(client,query)).markets.length,0);
  assert.equal((await readYieldRates(client,{...query,since:query.until,until:'2026-09-03T01:00:00Z'})).markets.length,0);
  assert.equal((await readYieldRates(client,{...query,deploymentIdentitySha256:'2'.repeat(64)})).markets.length,0);
  assert.equal((await readYieldRates(client,{...query,market:pin.dusk.programId})).markets.length,0);
  assert.equal((await readYieldRates(client,{...query,market:end.market})).markets.length,0);
}));

test('a conflicting unprojected market observation halts rate reads',()=>transaction(async client=>{
  const {end}=await seed(client);
  await storeYieldCheckpointSource(client,{...end,blockhash:pin.dusk.programId});
  await assert.rejects(readYieldRates(client,query),/contradictory committed market/);
}));

test('unregistered identities do not get historical rates from another API release',()=>transaction(async client=>{
  await seed(client,{deployment:'3'.repeat(64)});
  assert.equal((await readYieldRates(client,query)).markets.length,0);
}));

test('zero-length, too-short, excessive and malformed windows are rejected',()=>transaction(async client=>{
  for (const until of [query.since,'2026-09-01T01:59:59Z','2027-09-01T00:00:00Z','bad'])
    await assert.rejects(readYieldRates(client,{...query,until}),/Invalid recorded yield window/);
}));

test('API-only builds reuse rates only after both saved boundaries are attested to the same pinned release',()=>transaction(async client=>{
  const original=historyDeploymentFixture('old-yield-worker'),deployment=historyDeploymentFixture();
  await seed(client,{deployment:original.deploymentIdentitySha256});
  const selection={...query,deployment,deploymentIdentitySha256:deployment.deploymentIdentitySha256};
  assert.equal((await readYieldRates(client,selection)).markets.length,0);
  await storeCaptureDeployment(client,original);
  assert.equal((await readYieldRates(client,selection)).markets[0].rates.claimableRatePct,'91.4325');
  await assert.rejects(readYieldRates(client,{...selection,deployment:{...deployment,programDataSlot:String(Number(deployment.programDataSlot)+1)}}),/historical deployment/);
}));
