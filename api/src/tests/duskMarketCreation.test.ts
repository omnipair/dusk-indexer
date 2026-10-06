import test from 'node:test';
import assert from 'node:assert/strict';
import { withMarketCreation } from '../services/duskReadModel';

test('a market the stream saw created carries where its history begins', () => {
  const payload = withMarketCreation(
    { marketAddress: 'AEwmr5XajnL6YMgd83ty9YmxUAqiEwxHvCNzGJ4twPeJ', createdTxSig: null },
    { signature: '5xSig', slot: 504824168, time: '2026-09-27T15:12:05.000Z' },
  );
  assert.equal(payload.marketAddress, 'AEwmr5XajnL6YMgd83ty9YmxUAqiEwxHvCNzGJ4twPeJ');
  assert.equal(payload.createdTxSig, '5xSig');
  assert.equal(payload.createdSlot, 504824168);
  assert.equal(payload.createdAt, '2026-09-27T15:12:05.000Z');
  assert.equal(payload.historyFromCreation, true);
});

test('a market created before the release says its earlier history is missing', () => {
  const payload = withMarketCreation(
    { marketAddress: '7Rjrf8i81hZihsuFdPfzTaP6SiQ3JEmQs7Hfg7YNjkNm' },
    undefined,
  );
  assert.equal(payload.createdTxSig, null);
  assert.equal(payload.createdSlot, null);
  assert.equal(payload.createdAt, null);
  assert.equal(payload.historyFromCreation, false);
});
