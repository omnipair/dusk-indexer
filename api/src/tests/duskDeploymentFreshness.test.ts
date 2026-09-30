import test from 'node:test';
import assert from 'node:assert/strict';
import { Connection } from '@solana/web3.js';
import { deploymentEnvelope, deploymentEnvelopeAt } from '../services/duskDeploymentService';
import { loadCurrentProtocol } from '../config/duskProtocol';

const protocol = require('../config/duskProtocol') as typeof import('../config/duskProtocol');
const coverage = require('../services/duskHistoryCoverage') as typeof import('../services/duskHistoryCoverage');

// Genesis is verified once per RPC endpoint for the life of the process, so
// each test uses its own endpoint.
function chain(context: test.TestContext, rpcUrl: string, genesis = loadCurrentProtocol().genesisHash) {
  const calls = { genesis: 0 };
  context.mock.method(protocol, 'duskApiConfig', () => ({ network: 'devnet', rpcUrl, buildRevision: 'test', primaryMarket: null }));
  context.mock.method(Connection.prototype, 'getGenesisHash', async () => { calls.genesis += 1; return genesis; });
  for (const method of ['getSlot', 'getMultipleAccountsInfoAndContext', 'getAccountInfo'] as const)
    context.mock.method(Connection.prototype, method, async () => { throw new Error('An envelope must not read program state'); });
  return calls;
}

test('database reads take the pinned identity at the live stream slot', async (context) => {
  const calls = chain(context, 'http://localhost:1');
  context.mock.method(coverage, 'readStreamedDeployment', async () => ({ slot: 500_000_100, updatedAt: new Date() }));
  const current = loadCurrentProtocol();
  const streamed = await deploymentEnvelope(500_000_050);
  assert.equal(streamed.sourceSlot, 500_000_100);
  assert.ok(Date.now()-Date.parse(streamed.observedAt) < 1000);
  assert.equal(streamed.programDataAddress, current.dusk.deployment.programData);
  assert.equal(streamed.programDataSlot, String(current.dusk.deployment.deploySlot));
  assert.equal(streamed.programBinarySha256, current.dusk.binarySha256);
  assert.equal(streamed.leverageDelegateProgramDataSlot, String(current.leverageDelegate.deployment.deploySlot));
  assert.equal(streamed.leverageDelegateBinarySha256, current.leverageDelegate.binarySha256);
  // A read above the stream is covered at its own slot under the same identity.
  const covering = await deploymentEnvelope(500_000_101);
  assert.equal(covering.sourceSlot, 500_000_101);
  assert.equal(covering.deploymentIdentitySha256, streamed.deploymentIdentitySha256);
  assert.equal(calls.genesis, 1);
});

test('a stale or unattested stream serves no identity', async (context) => {
  chain(context, 'http://localhost:2');
  let stream: { slot: number; updatedAt: Date } | null = { slot: 500_000_100, updatedAt: new Date(Date.now()-16_000) };
  context.mock.method(coverage, 'readStreamedDeployment', async () => stream);
  await assert.rejects(deploymentEnvelope(), (error: Error & { status?: number }) => /stale/.test(error.message) && error.status === 503);
  stream = null;
  await assert.rejects(deploymentEnvelope(), (error: Error & { status?: number }) => /not attested/.test(error.message) && error.status === 503);
});

test('a live capture covers its own slot without the ingestion cursor', async (context) => {
  chain(context, 'http://localhost:3');
  context.mock.method(coverage, 'readStreamedDeployment', async () => {
    throw new Error('A live capture must not reuse the ingestion cursor');
  });
  const captured = await deploymentEnvelopeAt(500_002_000);
  assert.equal(captured.sourceSlot, 500_002_000);
  for (const slot of [-1, NaN, 0.5, Infinity]) {
    await assert.rejects(deploymentEnvelopeAt(slot), /Invalid deployment/);
    await assert.rejects(deploymentEnvelope(slot), /Invalid deployment/);
  }
});

test('an RPC on another cluster serves no identity until it matches the pin', async (context) => {
  const calls = chain(context, 'http://localhost:4', 'another-cluster');
  await assert.rejects(deploymentEnvelopeAt(500_003_000), /does not match the pinned cluster/);
  // A failed check is not cached; the next envelope asks again.
  await assert.rejects(deploymentEnvelopeAt(500_003_000), /does not match the pinned cluster/);
  assert.equal(calls.genesis, 2);
  context.mock.method(Connection.prototype, 'getGenesisHash', async () => { calls.genesis += 1; return loadCurrentProtocol().genesisHash; });
  await deploymentEnvelopeAt(500_003_000);
  await deploymentEnvelopeAt(500_003_001);
  assert.equal(calls.genesis, 3);
});
