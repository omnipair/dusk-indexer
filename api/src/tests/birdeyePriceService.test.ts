import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractBirdeyePrice,
  extractBirdeyePricePoints,
  fetchBirdeyeHistoricalPrice,
  fetchBirdeyeHistoricalPriceRange,
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

test('extractBirdeyePricePoints reads hourly range responses', () => {
  const points = extractBirdeyePricePoints({
    data: {
      items: [
        { unixTime: 1778256000, value: '1.10' },
        { unixTime: 1778259600, value: 1.25 },
        { unixTime: 1778263200, value: 0 },
      ],
    },
  });

  assert.equal(points.length, 2);
  assert.equal(points[0].timestamp.toISOString(), '2026-05-08T16:00:00.000Z');
  assert.equal(points[0].priceUsd, 1.1);
  assert.equal(points[1].priceUsd, 1.25);
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

test('fetchBirdeyeHistoricalPriceRange returns parsed hourly points', async () => {
  let requestedUrl = '';
  const fetchImpl: typeof fetch = async (input) => {
    requestedUrl = String(input);
    return new Response(JSON.stringify({
      data: {
        items: [
          { unixTime: 1778256000, value: '1.10' },
          { unixTime: 1778259600, value: '1.20' },
        ],
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const result = await fetchBirdeyeHistoricalPriceRange(
    'So11111111111111111111111111111111111111112',
    new Date('2026-05-08T16:00:00Z'),
    new Date('2026-05-08T18:00:00Z'),
    {
      apiKey: 'test-key',
      baseUrl: 'https://example.test',
      fetchImpl,
    }
  );

  assert.ok(result);
  assert.equal(result.length, 2);
  assert.equal(result[0].mint, 'So11111111111111111111111111111111111111112');
  assert.equal(result[1].priceUsd, 1.2);
  assert.match(requestedUrl, /time_from=1778256000/);
  assert.match(requestedUrl, /time_to=1778263200/);
});
