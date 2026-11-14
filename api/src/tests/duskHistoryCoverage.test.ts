import test from 'node:test';
import assert from 'node:assert/strict';
import { historyScanCovers, marketCreationCovers, HistoryScan } from '../services/duskHistoryCoverage';

const scan: HistoryScan = { basis: 'confirmed-stream.v1',firstSlot: '100',throughSlot: '1000',
  releaseBlockTime: '2026-09-01T00:00:00.000Z',throughBlockTime: '2026-09-02T00:00:00.000Z',completedAt: '2026-09-02T00:00:01.000Z' };
test('only a bounded range strictly inside the covered interval is complete',() => {
  assert.equal(historyScanCovers(scan,'2026-09-01T01:00:00Z','2026-09-01T23:59:59.999Z'),true);
  assert.equal(historyScanCovers(null,'2026-09-01T01:00:00Z','2026-09-01T23:59:59Z'),false);
  assert.equal(historyScanCovers(scan,undefined,'2026-09-01T23:59:59Z'),false);
  assert.equal(historyScanCovers(scan,scan.releaseBlockTime,'2026-09-01T23:59:59Z'),false);
  assert.equal(historyScanCovers(scan,'2026-09-01T01:00:00Z',scan.throughBlockTime),false);
  assert.equal(historyScanCovers(scan,'2026-09-01T01:00:00Z','2026-09-03T00:00:00Z'),false);
});


test('a market created inside the stream has complete lifetime coverage before the first full day',() => {
  const creation = { createdAt: '2026-09-01T00:01:00Z',createdSlot: String(Number(scan.firstSlot)+1) };
  assert.equal(marketCreationCovers(scan,creation,'2026-09-01T23:59:59.999Z'),true);
  assert.equal(marketCreationCovers(scan,creation,scan.throughBlockTime),false);
  assert.equal(marketCreationCovers(scan,{ ...creation,createdAt: scan.releaseBlockTime },'2026-09-01T23:59:59Z'),false);
  assert.equal(marketCreationCovers(scan,{ ...creation,createdSlot: '0' },'2026-09-01T23:59:59Z'),false);
  assert.equal(marketCreationCovers(null,creation,'2026-09-01T23:59:59Z'),false);
});
