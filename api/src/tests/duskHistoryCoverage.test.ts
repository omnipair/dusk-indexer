import test from 'node:test';
import assert from 'node:assert/strict';
import { historyScanCovers, HistoryScan } from '../services/duskHistoryCoverage';

const scan: HistoryScan = { basis: 'finalized-address-scan.v1',firstSlot: '100',throughSlot: '1000',
  releaseBlockTime: '2026-09-01T00:00:00.000Z',throughBlockTime: '2026-09-02T00:00:00.000Z',completedAt: '2026-09-02T00:00:01.000Z' };
test('only a bounded range strictly inside a decoded scan is complete',() => {
  assert.equal(historyScanCovers(scan,'2026-09-01T01:00:00Z','2026-09-01T23:59:59.999Z'),true);
  assert.equal(historyScanCovers(null,'2026-09-01T01:00:00Z','2026-09-01T23:59:59Z'),false);
  assert.equal(historyScanCovers(scan,undefined,'2026-09-01T23:59:59Z'),false);
  assert.equal(historyScanCovers(scan,scan.releaseBlockTime,'2026-09-01T23:59:59Z'),false);
  assert.equal(historyScanCovers(scan,'2026-09-01T01:00:00Z',scan.throughBlockTime),false);
  assert.equal(historyScanCovers(scan,'2026-09-01T01:00:00Z','2026-09-03T00:00:00Z'),false);
});
