import test from 'node:test';
import assert from 'node:assert/strict';
import { captureStatisticsSnapshot, statisticsDependencies } from '../services/duskStatisticsSnapshot';
import type { DuskDeploymentEnvelope } from '../services/duskDeploymentService';
import type { HistoryScan } from '../services/duskHistoryCoverage';

const now = Date.parse('2026-11-16T10:00:00Z');
const deployment = { deploymentIdentitySha256: 'a'.repeat(64) } as DuskDeploymentEnvelope;
const scan: HistoryScan = {
  basis: 'confirmed-stream.v1',firstSlot: '1',throughSlot: '100',
  releaseBlockTime: '2026-11-14T00:00:00Z',
  throughBlockTime: new Date(now - 5_000).toISOString(),
  completedAt: new Date(now - 5_000).toISOString(),
};

function fixture(history: HistoryScan | null = scan) {
  const requests: Parameters<typeof statisticsDependencies.activity>[0][] = [];
  let scans = 0,exposures = 0;
  const dependencies = {
    now: () => now,
    historyScan: async () => { scans++; return history; },
    activity: async (request: Parameters<typeof statisticsDependencies.activity>[0]) => {
      requests.push(request);
      return { coverage: { lastSourceSlot: '99',historyScan: history } };
    },
    exposures: async () => {
      exposures++;
      return { sourceSlot: 101,observedAt: now,complete: true,markets: [] };
    },
  } as unknown as typeof statisticsDependencies;
  return { dependencies,requests,counts: () => ({ scans,exposures }) };
}

test('24h statistics value one covered window instead of scanning twice',async () => {
  const f = fixture();
  const result = await captureStatisticsSnapshot('24h',deployment,undefined,f.dependencies);
  const end = now - 5_001;
  assert.deepEqual(result.request,{
    since: new Date(end - 86_400_000).toISOString(),until: new Date(end).toISOString(),
  });
  assert.equal(f.requests.length,1);
  assert.deepEqual(f.requests[0],{
    ...result.request,deployment,deploymentIdentitySha256: deployment.deploymentIdentitySha256,
  });
  assert.deepEqual(f.counts(),{ scans: 1,exposures: 1 });
  assert.equal(result.sourceSlot,101);
});

test('missing, stale and future cursors do not claim a covered trailing day',async () => {
  for (const history of [null,
    { ...scan,throughBlockTime: new Date(now - 120_000).toISOString() },
    { ...scan,throughBlockTime: new Date(now + 1).toISOString() },
  ]) {
    const f = fixture(history);
    const result = await captureStatisticsSnapshot('24h',deployment,undefined,f.dependencies);
    assert.deepEqual(result.request,{
      since: new Date(now - 86_400_000).toISOString(),until: new Date(now).toISOString(),
    });
    assert.equal(f.requests.length,1);
  }
});

test('all-time statistics retain their unbounded start and need no preliminary cursor',async () => {
  const f = fixture();
  const result = await captureStatisticsSnapshot('all',deployment,undefined,f.dependencies);
  assert.deepEqual(result.request,{ until: new Date(now).toISOString() });
  assert.equal(f.requests.length,1);
  assert.deepEqual(f.counts(),{ scans: 0,exposures: 1 });
});

test('statistics stop on cancellation before starting database work or after the cursor read',async () => {
  const controller = new AbortController();
  controller.abort();
  const f = fixture();
  await assert.rejects(captureStatisticsSnapshot('24h',deployment,controller.signal,f.dependencies),{ name: 'AbortError' });
  assert.deepEqual(f.counts(),{ scans: 0,exposures: 0 });
  assert.equal(f.requests.length,0);

  const duringCursor = new AbortController();
  f.dependencies.historyScan = async () => { duringCursor.abort(); return scan; };
  await assert.rejects(captureStatisticsSnapshot('24h',deployment,duringCursor.signal,f.dependencies),{ name: 'AbortError' });
  assert.equal(f.requests.length,0);
});
