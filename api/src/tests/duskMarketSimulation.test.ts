import test from 'node:test';
import assert from 'node:assert/strict';
import { Connection, PublicKey, SimulateTransactionConfig, VersionedTransaction } from '@solana/web3.js';
import { captureLiveMarketSimulation, captureMarketSimulation } from '../services/duskMarketSimulation';
import { DuskDeploymentEnvelope } from '../services/duskDeploymentService';
import { loadPinnedProtocol } from '../config/duskProtocol';
import { priceFixture } from './duskPriceFixtures';
import { fixtureKey } from './duskYieldCheckpointFixtures';

function fixture(options: { failed?: boolean; identityChanged?: boolean; slot?: number; shortAccounts?: boolean; wrongProgram?: boolean;
  badEncoding?: boolean; noPreview?: boolean; regressedFallback?: boolean; transientFailures?: number; live?: boolean } = {}) {
  const pin = loadPinnedProtocol(),source = priceFixture().source(),requestedSlots: number[] = [],extra = fixtureKey(145).toBase58();
  let envelopeCalls = 0,fallbackCalls = 0,simulationCalls = 0;
  const rpc = {
    simulateTransaction: async (transaction: VersionedTransaction,config: SimulateTransactionConfig) => {
      assert.equal(config.commitment,options.live ? 'confirmed' : 'finalized'); assert.equal(config.sigVerify,false); assert.equal(config.replaceRecentBlockhash,true);
      assert.equal(config.minContextSlot,source.slot); assert.equal(config.accounts?.addresses[0],source.market);
      if (++simulationCalls<=(options.transientFailures ?? 0)) throw new Error('failed to simulate transaction: Minimum context slot has not been reached');
      assert.ok(transaction.serialize().length<=1232);
      for (const address of config.accounts!.addresses) assert.ok(transaction.message.staticAccountKeys.some((key) => key.toBase58() === address));
      const returned = { programId: options.wrongProgram ? fixtureKey(144).toBase58() : pin.dusk.programId,
        data: [options.badEncoding ? source.rawPreview+'?' : source.rawPreview,'base64'] };
      const accounts = config.accounts!.addresses.map((_,index) => index === 0
        ? { owner: pin.dusk.programId,executable: false,data: [source.rawMarket,'base64'] } : null);
      return { context: { slot: options.slot ?? source.slot },value: { err: options.failed ? { InstructionError: [2,'InvalidArgument'] } : null,
        returnData: options.noPreview ? null : returned,accounts: options.shortAccounts ? accounts.slice(0,-1) : accounts } };
    },
    getMultipleAccountsInfoAndContext: async (keys: PublicKey[],config: { commitment: string; minContextSlot: number }) => {
      fallbackCalls++; assert.equal(config.commitment,options.live ? 'confirmed' : 'finalized'); assert.equal(config.minContextSlot,source.slot);
      return { context: { slot: source.slot+(options.regressedFallback ? -1 : 1) },value: keys.map((_,index) => index === 0
        ? { owner: new PublicKey(pin.dusk.programId),executable: false,data: Buffer.from(source.rawMarket,'base64') } : null) };
    },
  } as unknown as Connection;
  const dependencies = { rpc,envelope: async (slot = 0) => {
    requestedSlots.push(slot); envelopeCalls++;
    return { programUpgradeAuthority: fixtureKey(143).toBase58(),deploymentIdentitySha256: options.identityChanged && envelopeCalls>1 ? 'c'.repeat(64) : source.deploymentIdentitySha256 } as DuskDeploymentEnvelope;
  },readBlock: async (_rpc: unknown,slot: number) => ({ blockhash: source.blockhash,parentSlot: slot-1,blockTime: 1788307200 }),pause: async () => {} };
  return { source,extra,dependencies,requestedSlots,fallbackCalls: () => fallbackCalls,simulationCalls: () => simulationCalls };
}

test('preview capture requests related accounts at the same finalized simulation bank without signing',async () => {
  const sample = fixture();
  const snapshot = await captureMarketSimulation(sample.source.market,sample.source.slot,[sample.extra],sample.dependencies);
  assert.equal(snapshot.basis,'simulation-post-state'); assert.equal(snapshot.slot,sample.source.slot);
  assert.equal(snapshot.marketAccount.data,sample.source.rawMarket); assert.equal(snapshot.preview,sample.source.rawPreview);
  assert.deepEqual(snapshot.accounts,[{ address: sample.extra,account: null }]);
  assert.deepEqual(sample.requestedSlots,[sample.source.slot,sample.source.slot]);
  assert.equal(sample.fallbackCalls(),0);
});
test('live market reads use confirmed banks and retain an explicit commitment on successful and failed previews',async () => {
  for (const failed of [false,true]) {
    const sample = fixture({ live: true,failed });
    const snapshot = await captureLiveMarketSimulation(sample.source.market,sample.source.slot,[sample.extra],sample.dependencies);
    assert.equal(snapshot.commitment,'confirmed'); assert.equal(snapshot.previewUnavailable,failed);
    assert.equal(sample.fallbackCalls(),failed ? 1 : 0);
  }
});
test('the maximum account batch fits in a real serialized Solana packet',async () => {
  const sample = fixture(),addresses = Array.from({ length: 20 },(_,index) => fixtureKey(150+index).toBase58());
  const snapshot = await captureMarketSimulation(sample.source.market,sample.source.slot,addresses,sample.dependencies);
  assert.equal(snapshot.accounts.length,20);
  await assert.rejects(captureMarketSimulation(sample.source.market,sample.source.slot,[...addresses,fixtureKey(190).toBase58()],sample.dependencies),/bounded/);
});
test('failed market previews preserve fresh raw account visibility with no usable valuation preview',async () => {
  const sample = fixture({ failed: true });
  const snapshot = await captureMarketSimulation(sample.source.market,sample.source.slot,[sample.extra],sample.dependencies);
  assert.equal(snapshot.basis,'rpc-account'); assert.equal(snapshot.previewUnavailable,true); assert.equal(snapshot.preview,null);
  assert.equal(snapshot.slot,sample.source.slot+1); assert.equal(sample.fallbackCalls(),1);
  assert.deepEqual(sample.requestedSlots,[sample.source.slot,sample.source.slot+1]);
});
test('regressed simulation and fallback banks are rejected rather than accepted as current',async () => {
  const sample = fixture({ slot: 1,failed: true });
  await assert.rejects(captureMarketSimulation(sample.source.market,sample.source.slot,[],sample.dependencies),/Regressed/);
  assert.equal(sample.fallbackCalls(),0);
  const other = fixture({ failed: true,regressedFallback: true });
  await assert.rejects(captureMarketSimulation(other.source.market,other.source.slot,[],other.dependencies),/regressed/);
});
test('a successful RPC response with missing, foreign or malformed program return data fails closed',async () => {
  for (const options of [{ wrongProgram: true },{ badEncoding: true },{ noPreview: true },{ shortAccounts: true }]) {
    const sample = fixture(options);
    await assert.rejects(captureMarketSimulation(sample.source.market,sample.source.slot,[sample.extra],sample.dependencies),/data|snapshot/);
    assert.equal(sample.fallbackCalls(),0);
  }
});
test('a preview at a different embedded slot cannot be paired with the account bank',async () => {
  const sample = fixture({ slot: priceFixture().source().slot+1 });
  await assert.rejects(captureMarketSimulation(sample.source.market,sample.source.slot,[],sample.dependencies),/slots differ/);
});
test('a deployment change during capture invalidates the complete response',async () => {
  const sample = fixture({ identityChanged: true });
  await assert.rejects(captureMarketSimulation(sample.source.market,sample.source.slot,[],sample.dependencies),/Deployment changed/);
});
test('block-time lookup overlaps final attestation, and the snapshot waits for both',async () => {
  const sample=fixture(),originalEnvelope=sample.dependencies.envelope,originalBlock=sample.dependencies.readBlock;
  let release!:()=>void,entered!:()=>void,blockStarted=false,settled=false;
  const gate=new Promise<void>(resolve=>{release=resolve;}),afterStarted=new Promise<void>(resolve=>{entered=resolve;});
  sample.dependencies.envelope=async(slot=0)=>{
    const result=await originalEnvelope(slot);
    if(sample.requestedSlots.length===2) { entered(); await gate; }
    return result;
  };
  sample.dependencies.readBlock=async(rpc,slot)=>{blockStarted=true;return originalBlock(rpc,slot);};
  const pending=captureMarketSimulation(sample.source.market,sample.source.slot,[],sample.dependencies);
  void pending.then(()=>{settled=true;});
  await afterStarted;
  try {assert.equal(blockStarted,true);assert.equal(settled,false);}
  finally {release();await pending;}
});
test('missing block time still prevents a snapshot when the final identity is valid',async()=>{
  const sample=fixture();
  sample.dependencies.readBlock=async()=>{throw new Error('Captured block unavailable');};
  await assert.rejects(captureMarketSimulation(sample.source.market,sample.source.slot,[],sample.dependencies),/Captured block unavailable/);
});
test('duplicate market or related accounts are rejected before any network work',async () => {
  const sample = fixture();
  for (const addresses of [[sample.source.market],[sample.extra,sample.extra]])
    await assert.rejects(captureMarketSimulation(sample.source.market,sample.source.slot,addresses,sample.dependencies),/bounded/);
  assert.equal(sample.requestedSlots.length,0);
});
test('a lagging RPC replica is retried with the unchanged minimum slot and bounded attempts',async () => {
  const sample = fixture({ transientFailures: 2 });
  const result = await captureMarketSimulation(sample.source.market,sample.source.slot,[],sample.dependencies);
  assert.equal(result.slot,sample.source.slot); assert.equal(sample.simulationCalls(),3);
  const unavailable = fixture({ transientFailures: 10 });
  await assert.rejects(captureMarketSimulation(unavailable.source.market,unavailable.source.slot,[],unavailable.dependencies),/Minimum context slot/);
  assert.equal(unavailable.simulationCalls(),4);
});
