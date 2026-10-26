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
    { proposal: 'delegated', market, lockedAmount: '30', directAmount: '0', reusableAmount: '30' },
    { proposal: 'direct', market, lockedAmount: '65', directAmount: '45', reusableAmount: '20' },
  ]);
});

test('reusable capture follows current delegation and binds exact allocation accounts after discovery', async () => {
  const { displayFixture } = await import('./duskDisplayStateFixtures');
  const { captureReusableGovernance } = await import('../services/duskOwnerGovernance');
  const { deriveGovernanceBalanceAddress, deriveGovernanceSupportAddress } = await import('../services/virtualBook/native');
  const { PublicKey } = await import('@solana/web3.js');
  const { BN } = await import('@coral-xyz/anchor');
  const { IdlCoder } = await import('@coral-xyz/anchor/dist/cjs/coder/borsh/idl');
  const f = await displayFixture(), program = f.dusk.program.programId;
  const market=displayKey(30),holder=displayKey(31),delegate=displayKey(32),proposal=displayKey(33);
  const [balanceKey,bump]=deriveGovernanceBalanceAddress(market,holder,program);
  const [supportKey,supportBump]=deriveGovernanceSupportAddress(proposal,balanceKey,program);
  const layout=(name:string)=>IdlCoder.typeDefLayout({typeDef:f.dusk.program.idl.types!.find(row=>row.name===name)!,types:f.dusk.program.idl.types!});
  const balance=layout('governanceBalance').decode(Buffer.alloc(32768));
  Object.assign(balance,{market,owner:holder,delegate,totalAmount:new BN(100),committedAmount:new BN(20),bump});
  const support=layout('governanceSupport').decode(Buffer.alloc(32768));
  Object.assign(support,{proposal,governanceBalance:balanceKey,amount:new BN(20),rentRefund:delegate,bump:supportBump});
  const encode=(name:string,value:unknown)=>{
    const data=Buffer.alloc(32768),size=layout(name).encode(value,data);
    return {executable:false,owner:program,lamports:1,data:Buffer.concat([Buffer.from(f.dusk.program.idl.accounts!.find(row=>row.name===name)!.discriminator),data.subarray(0,size)])};
  };
  f.dusk.program.provider.connection.getMultipleAccountsInfoAndContext=async(keys,config)=>{
    assert.equal((config as {minContextSlot:number}).minContextSlot,3001);
    return {context:{slot:3005},value:keys.map(key=>key.equals(balanceKey)?encode('governanceBalance',balance):key.equals(supportKey)?encode('governanceSupport',support):null)};
  };
  const client={query:async(sql:string)=>({rows:sql.includes("event_name='GovernanceBalanceUpdated'")?[{market:market.toBase58(),owner:holder.toBase58()}]:sql.includes("event_name='GovernanceSupportChanged'")?[{proposal:proposal.toBase58(),balance:balanceKey.toBase58()}]:[{through_slot:'3001',updated_at:new Date(),registered_at:new Date()}]})} as unknown as Pool;
  const read=()=>captureReusableGovernance(f.dusk,delegate.toBase58(),market.toBase58(),3000,undefined,client);
  const result=await read();
  assert.equal(result.balances[0].availableAmount,'80');
  assert.equal(result.allocations[0].amount,'20');
  assert.equal(result.allocations[0].rentRefund,delegate.toBase58());
  balance.delegate=PublicKey.default;
  assert.deepEqual((await read()).balances,[]);
  balance.delegate=delegate; support.amount=new BN(19);
  await assert.rejects(read(),/fully indexed/);
  support.amount=new BN(20); balance.market=displayKey(40);
  await assert.rejects(read(),/identity/);
});
