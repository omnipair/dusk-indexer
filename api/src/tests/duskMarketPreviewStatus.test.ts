import test from 'node:test';
import assert from 'node:assert/strict';
import { DuskDeploymentEnvelope } from '../services/duskDeploymentService';
import { deploymentSnapshot, failingMarketPreviews, marketPreviewStatus } from '../services/duskMarketSurface';

const market = (address: string, previewStatus: string, previewFailure?: unknown) =>
  ({ marketAddress: address,label: `${address}/USDC`,state: { previewStatus,...(previewFailure === undefined ? {} : { previewFailure }) } });
const deployment = { deploymentIdentitySha256: 'a'.repeat(64) } as DuskDeploymentEnvelope;

test('status names each market whose preview failed, with the reason it reports',() => {
  assert.deepEqual(failingMarketPreviews([
    market('META','unavailable',{ reason: 'oracle-stale',errorName: 'OracleStale',errorCode: 6148 }),
    market('SOL','available',null),
    market('OLD','unavailable'),
  ]),[
    { market: 'META',label: 'META/USDC',reason: 'oracle-stale',errorName: 'OracleStale' },
    { market: 'OLD',label: 'OLD/USDC',reason: null,errorName: null },
  ]);
});
test('status reads the market surface and reports a failed read instead of throwing',async () => {
  const read = (async () => ({ projected: [market('META','unavailable',{ reason: 'oracle-stale',errorName: 'OracleStale' }),market('SOL','available',null)] })) as unknown as typeof deploymentSnapshot;
  assert.deepEqual(await marketPreviewStatus(deployment,read),
    { total: 2,failing: [{ market: 'META',label: 'META/USDC',reason: 'oracle-stale',errorName: 'OracleStale' }],error: null });
  const broken = (async () => { throw new Error('rpc down'); }) as unknown as typeof deploymentSnapshot;
  assert.deepEqual(await marketPreviewStatus(deployment,broken),{ total: 0,failing: [],error: 'rpc down' });
});
