import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadPinnedProtocol } from '../config/duskProtocol';
import { invalidateDuskReadCaches } from '../services/duskInvalidationService';
import { cache } from '../utils/cache';

test('another session trade evicts current preview snapshots only for the active deployment', () => {
  const pin = loadPinnedProtocol();
  const key = 'dusk:market_snapshot:deployment:market';
  cache.set(key, { price: 1 }, 5000);
  cache.set('dusk:block_time:test', 123, 5000);
  const notice = { cluster: pin.cluster, programId: pin.dusk.programId, idlHash: pin.dusk.idlCanonicalSha256,
    protocolRevision: pin.revision, slot: pin.historyFirstSlot };
  invalidateDuskReadCaches(JSON.stringify({...notice, protocolRevision:'wrong'}));
  assert.deepEqual(cache.get(key), {price:1});
  invalidateDuskReadCaches(JSON.stringify(notice));
  assert.equal(cache.get(key), null);
  assert.equal(cache.get('dusk:block_time:test'), 123);
});
