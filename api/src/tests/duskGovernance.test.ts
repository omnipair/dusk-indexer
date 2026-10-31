import test from 'node:test';
import assert from 'node:assert/strict';
import { governanceSelection } from '../services/duskGovernance';

test('governance selection takes one canonical market or none',() => {
  assert.equal(governanceSelection(undefined),null);
  const market = '11111111111111111111111111111111';
  assert.equal(governanceSelection(market),market);
  for (const value of ['',['a','b'],'not-a-key','1111111111111111111111111111111O',{}])
    assert.throws(() => governanceSelection(value),(error: Error & { status?: number }) => error.status === 400);
});

test('Oracle proposal projection follows the pinned family count and preserves decoder wire data', async () => {
  const { mock } = await import('node:test');
  const schema = await import('../services/duskProtocolSchema');
  const { readGovernanceProposals } = await import('../services/duskGovernance');
  const created = { metadata: { version: '1', title: 'Oracle', description_uri: 'https://example.com/terms',
    description_sha256: `0x${'ab'.repeat(32)}`, description_len: '12' },
    proposer: '11111111111111111111111111111111', nonce: '18446744073709551615',
    family_revisions: Array(8).fill('0'), digest: `0x${'cd'.repeat(32)}`, sponsorship_floor: '1', initial_support: '1',
    updates: [{ variant: 'Oracle', fields: [{ base_feed_id: `0x${'01'.repeat(32)}` }] }] };
  const row = { created, proposal: 'proposal', market: 'market', total_locked: '1', status: 0, eligible_supply_at_queue: null,
    queued_support: null, queued_at: null, execute_after: null, execution_deadline: null, executed_at: null, created_slot: '100', last_slot: '101' };
  const client = { query: async (sql: string) => ({ rows: sql.includes('streamed_governance_proposals') ? [row]
    : sql.includes('streamed_governance_markets') ? []
    : [{ through_slot: '102', updated_at: new Date(), registered_at: new Date() }] }) } as unknown as import('pg').PoolClient;
  const count = mock.method(schema,'governanceFamilyCount',() => 8);
  try {
    const result = await readGovernanceProposals(client,null);
    assert.equal(result.proposals[0].familyRevisions.length,8);
    assert.deepEqual(result.proposals[0].updates,created.updates);
    assert.equal(result.proposals[0].nonce,'18446744073709551615');
    created.family_revisions.pop();
    await assert.rejects(readGovernanceProposals(client,null),/proposal terms/);
    count.mock.mockImplementation(() => 7);
    assert.equal((await readGovernanceProposals(client,null)).proposals[0].familyRevisions.length,7);
  } finally { count.mock.restore(); }
});
