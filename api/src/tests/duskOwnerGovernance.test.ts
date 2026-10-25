import test from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { readOwnerGovernanceSupports } from '../services/duskOwnerGovernance';
import { displayKey } from './duskDisplayStateFixtures';

test('delegated creation aggregate is not assigned to its creator; later reusable support preserves direct creation', async () => {
  const owner = displayKey(10).toBase58(), market = displayKey(11).toBase58();
  const client = { query: async (sql: string) => {
    if (sql.includes('FROM dusk_ingestion.streamed_events e')) {
      // Delegation is decided by events from the same outer instruction.
      assert.match(sql, /g.signature=c.signature/);
      assert.match(sql, /support_observation.instruction_path\[1\]=creation_observation.instruction_path\[1\]/);
      assert.match(sql, /g.payload->>'proposal'=c.payload->>'proposal'/);
      return { rows: [
        { event_name: 'ParameterProposalCreated', market, delegated_creation: true, payload: { proposal: 'delegated', initial_support: '100' } },
        { event_name: 'GovernanceSupportChanged', market, delegated_creation: true, payload: { proposal: 'delegated', owner_support: '30' } },
        { event_name: 'ParameterProposalCreated', market, delegated_creation: true, payload: { proposal: 'other-owners-only', initial_support: '80' } },
        { event_name: 'ParameterProposalCreated', market, delegated_creation: false, payload: { proposal: 'direct', initial_support: '50' } },
        { event_name: 'GovernanceSupportChanged', market, delegated_creation: false, payload: { proposal: 'direct', owner_support: '20' } },
        { event_name: 'ParameterProposalSupportWithdrawn', market, delegated_creation: false, payload: { proposal: 'direct', amount: '5' } },
      ] };
    }
    return { rows: [{ through_slot: '100', updated_at: new Date(), registered_at: new Date() }] };
  } } as unknown as Pool;
  const result = await readOwnerGovernanceSupports(owner, null, client);
  assert.deepEqual(result.supports, [
    { proposal: 'delegated', market, lockedAmount: '30' },
    { proposal: 'direct', market, lockedAmount: '65' },
  ]);
});
