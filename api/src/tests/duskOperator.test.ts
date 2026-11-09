import test from 'node:test';
import { IdlCoder } from '@coral-xyz/anchor/dist/cjs/coder/borsh/idl';
import assert from 'node:assert/strict';
import { PublicKey } from '@solana/web3.js';
import type { Connection } from '@solana/web3.js';
import { captureMarketOperator } from '../services/duskOperator';
import type { DuskDeploymentEnvelope } from '../services/duskDeploymentService';
import { createVirtualBookRuntime } from '../services/virtualBook/native';
import fixture from './fixtures/virtual-book-batch-devnet-20261109.json';

async function setup() {
  const raw = fixture.result.value.accounts[0];
  const info = { ...raw, owner: new PublicKey(raw.owner), data: Buffer.from(raw.data[0], 'base64') };
  const state = { slot: fixture.result.context.slot, discovery: info, sameBank: info, snapshots: [] as string[][] };
  const connection = {
    getAccountInfoAndContext: async () => ({ context: { slot: state.slot }, value: state.discovery }),
    getMultipleAccountsInfoAndContext: async (keys: PublicKey[]) => {
      state.snapshots.push(keys.map(key => key.toBase58()));
      return { context: { slot: state.slot }, value: keys.map((_,index) => index === 0 ? state.sameBank : null) };
    },
  } as unknown as Connection;
  const { dusk } = await createVirtualBookRuntime(connection);
  const deployment = { programId: fixture.programId, sourceSlot: state.slot-1 } as DuskDeploymentEnvelope;
  const encode = (market: ReturnType<typeof dusk.program.coder.accounts.decode>) => {
    const layout = IdlCoder.typeDefLayout({ typeDef: dusk.program.idl.types!.find(row => row.name === 'market')!, types: dusk.program.idl.types! });
    const body = Buffer.alloc(16_384), length = layout.encode(market,body);
    return Buffer.concat([info.data.subarray(0,8),body.subarray(0,length)]);
  };
  return { dusk, state, deployment, encode };
}

test('operator display returns only a validated same-bank current market', async () => {
  const { dusk,state,deployment,encode } = await setup();
  const result = await captureMarketOperator(dusk,fixture.market,deployment);
  assert.deepEqual(state.snapshots,[[fixture.market]]);
  assert.equal(result.sourceSlot,state.slot);
  assert.equal(result.market.data,state.sameBank.data.toString('base64'));
  assert.equal(result.proposal,null);
  assert.equal(result.schemaVersion,'dusk-market-operator.v1');
});

test('operator display rejects foreign owners, old banks and a missing pending account', async () => {
  const { dusk,state,deployment,encode } = await setup();
  state.sameBank = { ...state.sameBank, owner: PublicKey.default };
  await assert.rejects(captureMarketOperator(dusk,fixture.market,deployment),/Unknown operator market/);
  state.sameBank = state.discovery;
  state.slot = deployment.sourceSlot-1;
  await assert.rejects(captureMarketOperator(dusk,fixture.market,deployment),/Stale operator discovery/);
  state.slot = deployment.sourceSlot+1;
  const market = dusk.program.coder.accounts.decode('market',state.discovery.data);
  market.operator.pending = new PublicKey(Buffer.alloc(32,17));
  state.discovery = state.sameBank = { ...state.discovery, data: encode(market) };
  await assert.rejects(captureMarketOperator(dusk,fixture.market,deployment),/Missing pending operator bundle/);
});

test('replacing a bundle between discovery and capture retries without mixing banks', async () => {
  const { dusk,state,deployment,encode } = await setup();
  const market = dusk.program.coder.accounts.decode('market',state.discovery.data);
  market.operator.pending = new PublicKey(Buffer.alloc(32,19));
  state.discovery = { ...state.discovery, data: encode(market) };
  await assert.rejects(captureMarketOperator(dusk,fixture.market,deployment),/changed during capture/);
  assert.equal(state.snapshots.length,3);
});
