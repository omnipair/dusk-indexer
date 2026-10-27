/** Disposable PostgreSQL only: every event fixture rolls back. */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { PoolClient } from 'pg';
import pool from '../config/database';
import { readGovernanceProposals } from '../services/duskGovernance';
import { readOwnerGovernanceSupports } from '../services/duskOwnerGovernance';
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
const bytes = (fill: number) => `0x${Buffer.from(Array.from({ length: 32 },(_,index) => (fill+index)%256)).toString('hex')}`;

test('owner support distinguishes delegated creation siblings from later reusable support',() => transaction(async client => {
  await streamedRelease(client,{ slot: 900_400_000,time: new Date(Date.now()-1000) });
  const { market } = fixtureMarket,owner = key(241),other = key(242),direct = key(243),delegated = key(244),zero = key(245);
  const initial = async (proposal: string,amount: string) => streamedEvent(client,'ParameterProposalCreated',
    { proposal,market,proposer: owner,initial_support: amount });
  const creation = await initial(delegated,'100');
  await streamedEvent(client,'GovernanceSupportChanged',{ proposal: delegated,market,owner,owner_support: '30' },
    creation.slot,undefined,streamedIdentity,creation.signature,[0,2]);
  const otherCreation = await initial(zero,'80');
  await streamedEvent(client,'GovernanceSupportChanged',{ proposal: zero,market,owner: other,owner_support: '80' },
    otherCreation.slot,undefined,streamedIdentity,otherCreation.signature);
  await initial(direct,'50');
  await streamedEvent(client,'GovernanceSupportChanged',{ proposal: direct,market,owner,owner_support: '20' });
  const result = await readOwnerGovernanceSupports(owner,market,client);
  assert.deepEqual(new Map(result.supports.map((row) => [row.proposal,row.lockedAmount])),new Map([[direct,'70'],[delegated,'30']]));
}));

test('direct creation retains its support when a later outer instruction adds reusable support in the same transaction',() => transaction(async client => {
  await streamedRelease(client,{ slot: 900_400_000,time: new Date(Date.now()-1000) });
  const { market } = fixtureMarket,owner = key(241),proposal = key(246);
  const creation = await streamedEvent(client,'ParameterProposalCreated',
    { proposal,market,proposer: owner,initial_support: '50' },undefined,undefined,streamedIdentity,undefined,[3,1]);
  await streamedEvent(client,'GovernanceSupportChanged',{ proposal,market,owner,owner_support: '20' },
    creation.slot,undefined,streamedIdentity,creation.signature,[4,1]);
  const result = await readOwnerGovernanceSupports(owner,market,client);
  assert.deepEqual(result.supports,[{ proposal,market,lockedAmount: '70',directAmount: '50',reusableAmount: '20' }]);
}));

test('a proposal carries its creation terms, latest totals and lifecycle times',() => transaction(async client => {
  await streamedRelease(client,{ slot: 900_400_000,time: new Date(Date.now()-1000) });
  await streamedMarket(client);
  const { market } = fixtureMarket,proposal = key(240),[proposer,alice,bob] = [241,242,243].map(key);
  await streamedEvent(client,'LiquidityAdded',{ market,owner: proposer,ylp_amount: '1000' });
  await streamedEvent(client,'LpTransferred',{ market,lp_mint: fixtureMarket.ylp,
    source_owner: proposer,destination_owner: market,amount: '200' });
  await streamedEvent(client,'ParameterProposalCreated',{ proposal,market,proposer,nonce: '7',
    family_revisions: ['3','0','0','0','0','0','0'],
    digest: bytes(1),sponsorship_floor: '20',initial_support: '25',status: '0',
    updates: [{ variant: 'Fee',fields: [{ swap_fee_bps: '30' }] }],
    metadata: { version: '1',title: 'Lower the fee',description_uri: 'ipfs://cid',description_sha256: bytes(9),description_len: '120' } });
  await streamedEvent(client,'ParameterProposalSupported',{ proposal,supporter: alice,amount: '100',supporter_locked: '100',total_locked: '125',status: '0' });
  await streamedEvent(client,'ParameterProposalSupportWithdrawn',{ proposal,supporter: alice,amount: '40',total_locked: '85',status: '0' });
  await streamedEvent(client,'ParameterProposalSupported',{ proposal,supporter: bob,amount: '50',supporter_locked: '50',total_locked: '135',status: '0' });
  let [row] = (await readGovernanceProposals(client,null)).proposals;
  assert.equal(row.totalLocked,'135'); assert.equal(row.status,0); assert.equal(row.queuedAt,null);
  assert.equal(row.digest,bytes(1).slice(2));
  assert.deepEqual(row.familyRevisions,['3','0','0','0','0','0','0']);
  assert.deepEqual(row.updates,[{ variant: 'Fee',fields: [{ swap_fee_bps: '30' }] }]);
  assert.deepEqual(row.metadata,{ version: 1,title: 'Lower the fee',descriptionUri: 'ipfs://cid',
    descriptionSha256: bytes(9).slice(2),descriptionLen: 120 });
  await streamedEvent(client,'ParameterProposalQueued',{ proposal,total_locked: '135',eligible_supply: '800',
    queued_at: '1790000000',execute_after: '1790086400',execution_deadline: '1790172800' });
  [row] = (await readGovernanceProposals(client,market)).proposals;
  assert.equal(row.status,1); assert.equal(row.eligibleSupplyAtQueue,'800'); assert.equal(row.queuedSupport,'135');
  assert.equal(row.executeAfter,1790086400); assert.equal(row.executionDeadline,1790172800);
  await streamedEvent(client,'ParameterProposalExecuted',{ proposal,market,families: '0x00',
    new_family_revisions: ['4','0','0','0','0','0','0'],executed_at: '1790090000' });
  const result = await readGovernanceProposals(client,market);
  [row] = result.proposals;
  assert.equal(row.status,2); assert.equal(row.executedAt,1790090000); assert.equal(row.totalLocked,'135');
  assert.deepEqual(result.markets,[{ address: market,eligibleYlp: '800',governanceLockedYlp: '135',
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
