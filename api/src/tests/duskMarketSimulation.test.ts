import test from 'node:test';
import assert from 'node:assert/strict';
import { Connection, PublicKey, SimulateTransactionConfig, VersionedTransaction } from '@solana/web3.js';
import { captureLiveMarketSimulation, captureMarketSimulation, duskRawIdl, previewFailureFrom } from '../services/duskMarketSimulation';
import { DuskDeploymentEnvelope } from '../services/duskDeploymentService';
import { loadPinnedProtocol } from '../config/duskProtocol';
import { priceFixture } from './duskPriceFixtures';
import { fixtureKey } from './duskYieldCheckpointFixtures';

function fixture(options: { failed?: boolean; failure?: unknown; identityChanged?: boolean; slot?: number; shortAccounts?: boolean; wrongProgram?: boolean;
  badEncoding?: boolean; noPreview?: boolean; regressedFallback?: boolean; transientFailures?: number; live?: boolean } = {}) {
  const pin = loadPinnedProtocol(),source = priceFixture().source(),requestedSlots: number[] = [],extra = fixtureKey(145).toBase58();
  let envelopeCalls = 0,fallbackCalls = 0,simulationCalls = 0;
  const rpc = {
    getAccountInfoAndContext: async () => ({ context: { slot: source.slot },value: {
      owner: new PublicKey(pin.dusk.programId),executable: false,data: Buffer.from(source.rawMarket,'base64') } }),
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
      return { context: { slot: options.slot ?? source.slot },value: { err: options.failed ? (options.failure ?? { InstructionError: [2,'InvalidArgument'] }) : null,
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
test('a failed preview keeps its reason, named from the pinned IDL, and a working one carries none',async () => {
  const stale = fixture({ live: true,failed: true,failure: { InstructionError: [2,{ Custom: 6148 }] } });
  const snapshot = await captureLiveMarketSimulation(stale.source.market,stale.source.slot,[stale.extra],stale.dependencies);
  assert.equal(snapshot.previewUnavailable,true);
  assert.deepEqual(snapshot.previewFailure,{ reason: 'oracle-stale',errorName: 'OracleStale',errorCode: 6148 });
  const working = fixture({ live: true });
  const ok = await captureLiveMarketSimulation(working.source.market,working.source.slot,[working.extra],working.dependencies);
  // A successful capture is unchanged, so saved evidence hashes the same.
  assert.equal('previewFailure' in ok,false);
});
test('preview failures map to oracle-stale, other program errors, or simulation errors',() => {
  const idl = duskRawIdl();
  assert.deepEqual(previewFailureFrom({ InstructionError: [2,{ Custom: 6148 }] },idl),{ reason: 'oracle-stale',errorName: 'OracleStale',errorCode: 6148 });
  assert.deepEqual(previewFailureFrom({ InstructionError: [2,{ Custom: 6147 }] },idl),
    { reason: 'program-error',errorName: 'OracleInvalidObservation',errorCode: 6147 });
  // Anchor's own codes and other programs' codes are not in the IDL.
  assert.deepEqual(previewFailureFrom({ InstructionError: [2,{ Custom: 3012 }] },idl),{ reason: 'program-error',errorName: null,errorCode: 3012 });
  assert.deepEqual(previewFailureFrom({ InstructionError: [2,'InvalidArgument'] },idl),{ reason: 'program-error',errorName: 'InvalidArgument',errorCode: null });
  // The compute-budget instructions ahead of the preview are not the program.
  assert.deepEqual(previewFailureFrom({ InstructionError: [1,{ Custom: 6148 }] },idl),{ reason: 'simulation-error',errorName: null,errorCode: null });
  assert.deepEqual(previewFailureFrom('AccountNotFound',idl),{ reason: 'simulation-error',errorName: 'AccountNotFound',errorCode: null });
  assert.deepEqual(previewFailureFrom({ InsufficientFundsForRent: { account_index: 0 } },idl),{ reason: 'simulation-error',errorName: null,errorCode: null });
  assert.deepEqual(previewFailureFrom('<not a name>',idl),{ reason: 'simulation-error',errorName: null,errorCode: null });
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

test('oracle capture adds configured reports at the policy bank and never values a failed preview', async () => {
  const { mock } = await import('node:test');
  const { readFileSync } = await import('node:fs');
  const { resolve } = await import('node:path');
  const schema = await import('../services/duskProtocolSchema');
  const { BorshCoder, BN } = await import('@coral-xyz/anchor');
  const root = resolve(__dirname,'../../../protocol/candidates/next-2026-10-31-8fadcc31');
  const idl = JSON.parse(readFileSync(resolve(root,'idl/dusk.json'),'utf8'));
  const fixture = JSON.parse(readFileSync(resolve(root,'fixtures/oracle-wire.json'),'utf8'));
  const pin = loadPinnedProtocol(),sourceSlot = 105,coder = new BorshCoder(idl);
  const marketAccount = coder.accounts.decode('Market',Buffer.from(fixture.marketHex,'hex')) as {
    base_side: { asset_mint: PublicKey }; quote_side: { asset_mint: PublicKey }; params_hash: number[]; bump: number;
  };
  const [activeMarket,activeBump] = PublicKey.findProgramAddressSync([
    Buffer.from('market_v2'),marketAccount.base_side.asset_mint.toBuffer(),marketAccount.quote_side.asset_mint.toBuffer(),
    Buffer.from(marketAccount.params_hash),
  ],new PublicKey(pin.dusk.programId));
  const raw = Buffer.from(fixture.marketHex,'hex'),marketAddress = activeMarket.toBase58();
  raw[raw.length-1] = activeBump;
  const pinned = mock.method(schema,'pinnedDuskIdl',() => idl);
  try {
    for (const failed of [false,true]) {
      let requested: string[] = [];
      const rpc = {
        getAccountInfoAndContext: async (_key: PublicKey,config: { minContextSlot: number }) => {
          assert.equal(config.minContextSlot,100);
          return { context: { slot: sourceSlot },value: { owner: new PublicKey(pin.dusk.programId),executable: false,data: raw } };
        },
        simulateTransaction: async (tx: VersionedTransaction,config: SimulateTransactionConfig) => {
          assert.equal(config.minContextSlot,sourceSlot);
          requested = config.accounts!.addresses;
          assert.deepEqual(requested,[marketAddress,fixture.policy.baseAccount]);
          assert.ok(tx.message.staticAccountKeys.some(key => key.toBase58() === fixture.policy.baseAccount));
          // The zero-valued fixture has no usable economics. This is a wire/bank
          // coherence test; successful return bytes need only the matching slot.
          const preview = coder.types.decode('MarketPreview',Buffer.alloc(4096)) as { slot: InstanceType<typeof BN> };
          preview.slot = new BN(sourceSlot);
          return { context: { slot: sourceSlot },value: { err: failed ? 'StaleOracle' : null,
            returnData: { programId: pin.dusk.programId,data: [coder.types.encode('MarketPreview',preview).toString('base64'),'base64'] },
            accounts: [{ owner: pin.dusk.programId,executable: false,data: [raw.toString('base64'),'base64'] },null] } };
        },
        getMultipleAccountsInfoAndContext: async (keys: PublicKey[],config: { minContextSlot: number }) => {
          assert.equal(config.minContextSlot,sourceSlot); assert.equal(keys.length,2);
          return { context: { slot: sourceSlot+1 },value: [{ owner: new PublicKey(pin.dusk.programId),executable: false,data: raw },null] };
        },
      } as unknown as Connection;
      const snapshot = await captureMarketSimulation(marketAddress,100,[],{ rpc,
        envelope: async () => ({ programUpgradeAuthority: fixtureKey(1).toBase58(),deploymentIdentitySha256: 'c'.repeat(64) } as DuskDeploymentEnvelope),
        readBlock: async (_rpc,slot) => ({ blockhash: fixtureKey(2).toBase58(),parentSlot: slot-1,blockTime: 1788307200 }) });
      assert.equal(snapshot.previewUnavailable,failed);
      assert.equal(snapshot.preview === null,failed);
      assert.equal(snapshot.slot,failed ? sourceSlot+1 : sourceSlot);
      assert.deepEqual(snapshot.accounts,[{ address: fixture.policy.baseAccount,account: null }]);
    }
  } finally { pinned.mock.restore(); }
});
