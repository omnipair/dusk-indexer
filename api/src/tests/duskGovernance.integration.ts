/** Disposable PostgreSQL only: every event fixture rolls back. */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { PoolClient } from 'pg';
import pool from '../config/database';
import { readGovernanceProposals } from '../services/duskGovernance';
import { fixtureMarket, key, streamedEvent, streamedIdentity, streamedMarket, streamedRelease } from './duskStreamedFixtures';

if (process.env.DUSK_ALLOW_DISPOSABLE_DB_TESTS !== 'true' || !process.env.DATABASE_URL)
  throw new Error('Set DUSK_ALLOW_DISPOSABLE_DB_TESTS=true and a disposable DATABASE_URL');
after(() => pool.end());
async function transaction(work: (client: PoolClient) => Promise<void>) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO dusk_ingestion.protocol_identities(cluster,program_id,idl_hash,protocol_revision)
      VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,streamedIdentity);
    await work(client);
  } finally { await client.query('ROLLBACK'); client.release(); }
}
const bytes = (fill: number) => Array.from({ length: 32 },(_,index) => String((fill+index)%256));

test('a proposal carries its creation terms, latest totals and lifecycle times',() => transaction(async client => {
  await streamedRelease(client,{ slot: 900_400_000,time: new Date(Date.now()-1000) });
  await streamedMarket(client);
  const { market } = fixtureMarket,proposal = key(240),[proposer,alice,bob] = [241,242,243].map(key);
  await streamedEvent(client,'MarketObserved',{ market,eligible_ylp: '1000',governance_locked_ylp: '150',ylp_supply: '900',base: {},quote: {} });
  await streamedEvent(client,'ParameterProposalCreated',{ proposal,market,proposer,nonce: '7',family: '0',family_revision: '3',
    digest: bytes(1),sponsorship_floor: '20',initial_support: '25',status: '0',
    update: { variant: 'Fee',fields: { swap_fee_bps: '30' } },
    metadata: { version: '1',title: 'Lower the fee',description_uri: 'ipfs://cid',description_sha256: bytes(9),description_len: '120' } });
  await streamedEvent(client,'ParameterProposalSupported',{ proposal,supporter: alice,amount: '100',supporter_locked: '100',total_locked: '125',status: '0' });
  await streamedEvent(client,'ParameterProposalSupportWithdrawn',{ proposal,supporter: alice,amount: '40',total_locked: '85',status: '0' });
  await streamedEvent(client,'ParameterProposalSupported',{ proposal,supporter: bob,amount: '50',supporter_locked: '50',total_locked: '135',status: '0' });
  let [row] = (await readGovernanceProposals(client,null)).proposals;
  assert.equal(row.totalLocked,'135'); assert.equal(row.status,0); assert.equal(row.queuedAt,null);
  assert.equal(row.digest,Buffer.from(bytes(1).map(Number)).toString('hex'));
  assert.deepEqual(row.update,{ variant: 'Fee',fields: { swap_fee_bps: '30' } });
  assert.deepEqual(row.metadata,{ version: 1,title: 'Lower the fee',descriptionUri: 'ipfs://cid',
    descriptionSha256: Buffer.from(bytes(9).map(Number)).toString('hex'),descriptionLen: 120 });
  await streamedEvent(client,'ParameterProposalQueued',{ proposal,total_locked: '135',eligible_supply: '1000',
    queued_at: '1790000000',execute_after: '1790086400',execution_deadline: '1790172800' });
  [row] = (await readGovernanceProposals(client,market)).proposals;
  assert.equal(row.status,1); assert.equal(row.eligibleSupplyAtQueue,'1000');
  assert.equal(row.executeAfter,1790086400); assert.equal(row.executionDeadline,1790172800);
  await streamedEvent(client,'ParameterProposalExecuted',{ proposal,market,family: '0',new_family_revision: '4',executed_at: '1790090000' });
  const result = await readGovernanceProposals(client,market);
  [row] = result.proposals;
  assert.equal(row.status,2); assert.equal(row.executedAt,1790090000); assert.equal(row.totalLocked,'135');
  assert.deepEqual(result.markets,[{ address: market,eligibleYlp: '1000',governanceLockedYlp: '150',
    observedSlot: result.markets[0].observedSlot,observedAt: result.markets[0].observedAt }]);
  assert.equal(result.sourceSlot,900_400_000);
  const supports = (await client.query(`SELECT supporter,locked_amount FROM dusk_ingestion.streamed_governance_supports
    WHERE proposal=$1 ORDER BY locked_amount DESC`,[proposal])).rows.map(r => [r.supporter,r.locked_amount]);
  assert.deepEqual(supports,[[alice,'60'],[bob,'50']]);
}));

test('a selected market without proposals or observations is still described',() => transaction(async client => {
  await streamedRelease(client,{ slot: 900_400_001,time: new Date(Date.now()-1000) });
  const market = key(250),result = await readGovernanceProposals(client,market);
  assert.deepEqual(result.proposals,[]);
  assert.deepEqual(result.markets,[{ address: market,eligibleYlp: null,governanceLockedYlp: null,observedSlot: null,observedAt: null }]);
}));
