import test from 'node:test';
import assert from 'node:assert/strict';
import { withTrancheRates } from '../services/duskTrancheRates';

const market = {
  marketAddress: 'market',
  ylpMint: 'senior',
  baseMint: 'base',
  quoteMint: 'quote',
  baseDecimals: 6,
  quoteDecimals: 6,
  tranches: {
    juniorMint: 'junior',
    seniorReserveShares: '80',
    juniorReserveShares: '20',
    rates: null,
  },
};

test('scales the recorded 50/50 income budget over live senior and junior capital', async () => {
  const result = await withTrancheRates(market, '0'.repeat(64), async () => ({
    market: 'market',
    growth: 'recorded',
    swapRatePct: '3',
    interestRatePct: '2',
  }));
  assert.deepEqual((result.tranches as any).rates.senior.totalRatePct, '5');
  assert.deepEqual((result.tranches as any).rates.junior.totalRatePct, '20');
  assert.equal(
    (result.tranches as any).rates.junior.estimate,
    'fixed-50-50-income-over-live-capital',
  );
});

test('keeps junior APY unavailable when no junior capital is live', async () => {
  const result = await withTrancheRates(
    {
      ...market,
      tranches: { ...market.tranches, juniorReserveShares: '0' },
    },
    '0'.repeat(64),
    async () => ({
      market: 'market',
      growth: 'recorded',
      swapRatePct: '3',
      interestRatePct: '2',
    }),
  );
  assert.equal((result.tranches as any).rates.junior, null);
});
