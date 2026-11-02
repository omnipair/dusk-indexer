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
    policy: { juniorIncomeShareBps: 5000, liquidationFeeBps: 100 },
    rates: null,
  },
};

const recorded: NonNullable<Parameters<typeof withTrancheRates>[2]> = async () => ({
  market: 'market',
  growth: 'recorded',
  swapRatePct: '3',
  interestRatePct: '2',
});

function withShare(juniorIncomeShareBps: number | null) {
  return {
    ...market,
    tranches: {
      ...market.tranches,
      policy: juniorIncomeShareBps === null ? null : { juniorIncomeShareBps, liquidationFeeBps: 100 },
    },
  };
}

test('at the default 50% share, junior earns senior income over its own live capital', async () => {
  const result = await withTrancheRates(market, '0'.repeat(64), recorded);
  const rates = (result.tranches as any).rates;
  assert.equal(rates.senior.totalRatePct, '5');
  assert.deepEqual(rates.junior, {
    growth: 'recorded',
    estimate: 'governed-income-share-over-live-capital',
    incomeShareBps: 5000,
    swapRatePct: '12',
    interestRatePct: '8',
    totalRatePct: '20',
  });
});

test('scales junior income by the governed share against senior', async () => {
  // 60% junior: junior earns 1.5x senior income over a quarter of its capital.
  const raised = (await withTrancheRates(withShare(6000), '0'.repeat(64), recorded)).tranches as any;
  assert.equal(raised.rates.senior.totalRatePct, '5');
  assert.equal(raised.rates.junior.incomeShareBps, 6000);
  assert.equal(raised.rates.junior.swapRatePct, '18');
  assert.equal(raised.rates.junior.interestRatePct, '12');
  assert.equal(raised.rates.junior.totalRatePct, '30');
  // 10% junior: 1/9 of senior income over a quarter of its capital.
  const lowered = (await withTrancheRates(withShare(1000), '0'.repeat(64), recorded)).tranches as any;
  assert.equal(lowered.rates.junior.swapRatePct, '1.33333333');
  assert.equal(lowered.rates.junior.interestRatePct, '0.88888889');
  assert.equal(lowered.rates.junior.totalRatePct, '2.22222222');
});

test('a zero share leaves junior with no income', async () => {
  const result = await withTrancheRates(withShare(0), '0'.repeat(64), recorded);
  assert.equal((result.tranches as any).rates.junior.totalRatePct, '0');
});

test('keeps junior APY unavailable without a share the program splits by', async () => {
  for (const share of [null, 10_000, 5000.5, -1]) {
    const result = await withTrancheRates(withShare(share), '0'.repeat(64), recorded);
    const rates = (result.tranches as any).rates;
    assert.equal(rates.senior.totalRatePct, '5');
    assert.equal(rates.junior, null, `share ${share}`);
  }
});

test('keeps junior APY unavailable when no junior capital is live', async () => {
  const result = await withTrancheRates(
    {
      ...market,
      tranches: { ...market.tranches, juniorReserveShares: '0' },
    },
    '0'.repeat(64),
    recorded,
  );
  assert.equal((result.tranches as any).rates.junior, null);
});
