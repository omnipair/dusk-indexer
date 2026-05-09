import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractBirdeyePrice,
  fetchBirdeyeHistoricalPrice,
} from '../services/birdeyePriceService';

test('extractBirdeyePrice reads direct value responses', () => {
  assert.equal(extractBirdeyePrice({ data: { value: 1.23 } }), 1.23);
});

test('extractBirdeyePrice reads item history responses', () => {
  assert.equal(
    extractBirdeyePrice({
      data: {
        items: [
          { unixTime: 1700000000, value: '0.42' },
        ],
      },
    }),
    0.42
  );
});

test('fetchBirdeyeHistoricalPrice calls history endpoint with Solana headers', async () => {
  let requestedUrl = '';
  let requestedChain = '';
  const fetchImpl: typeof fetch = async (input, init) => {
    requestedUrl = String(input);
    requestedChain = String((init?.headers as Record<string, string>)['x-chain']);
    return new Response(JSON.stringify({ data: { value: 9.5 } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const result = await fetchBirdeyeHistoricalPrice(
    'So11111111111111111111111111111111111111112',
    new Date('2026-05-09T00:00:00Z'),
    {
      apiKey: 'test-key',
      baseUrl: 'https://example.test',
      fetchImpl,
    }
  );

  assert.equal(result?.priceUsd, 9.5);
  assert.equal(requestedChain, 'solana');
  assert.match(requestedUrl, /\/defi\/history_price\?/);
  assert.match(requestedUrl, /address=So11111111111111111111111111111111111111112/);
  assert.match(requestedUrl, /type=1H/);
});
