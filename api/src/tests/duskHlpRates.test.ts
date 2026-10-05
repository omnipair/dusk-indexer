import test from 'node:test';
import assert from 'node:assert/strict';
import { HLP_RATE_WINDOW_MS, HlpVaultRateInput, projectHlpVaultRates, withHlpRates } from '../services/duskHlpRates';

// The devnet META/USDC base vault on 2026-10-05: 200 hLP backed by ~199.9 META
// of equity, owing ~174.4 USDC of funding at 1.1462 META per USDC.
function metaVault(overrides: Partial<HlpVaultRateInput> = {}): HlpVaultRateInput {
  return {
    side: 'base',
    baseDecimals: 6,
    quoteDecimals: 6,
    targetLeverageBps: 20000,
    vault: { hlpSupply: '200000000', mintSupply: '200000000', lastNavNad: '199915032083',
      fundingAprEmaNad: '2457112', fundingAprEmaLastSlot: '507640024' },
    state: { baseHlpFundingDebt: '0', quoteHlpFundingDebt: '174426578',
      baseSpotPriceNad: '872438227', quoteSpotPriceNad: '1146212957',
      baseBorrowAprNad: '639336', quoteBorrowAprNad: '1886803' },
    ylp: { market: 'M', swapRatePct: '1', interestRatePct: '0.5', growth: 'recorded' },
    windowMs: HLP_RATE_WINDOW_MS,
    ...overrides,
  };
}

test('a held vault earns its own leverage on yLP rates and pays funding on its debt', () => {
  const rates = projectHlpVaultRates(metaVault());
  // Debt worth 174.426578 × 1.146212957 = 199.93 META against 199.915 META of equity.
  assert.equal(rates.leverageBasis, 'vault');
  assert.equal(rates.leverageBps, '20000');
  assert.equal(rates.fundingBasis, 'ema');
  assert.equal(rates.swapRatePct, '2');
  assert.equal(rates.interestRatePct, '1');
  assert.equal(rates.fundingRatePct, '-0.2457112');
  assert.equal(rates.netRatePct, '2.7542888');
  assert.equal(rates.windowSeconds, 7 * 86400);
});

test('an empty vault quotes the target leverage and the borrowed asset\'s current rate', () => {
  const rates = projectHlpVaultRates(metaVault({
    side: 'quote',
    vault: { hlpSupply: '0', mintSupply: '0', lastNavNad: '0', fundingAprEmaNad: '0', fundingAprEmaLastSlot: '0' },
  }));
  // Quote hLP borrows base, so it pays base's 0.0639336% borrow rate on 1× equity.
  assert.equal(rates.leverageBasis, 'target');
  assert.equal(rates.leverageBps, '20000');
  assert.equal(rates.fundingBasis, 'current');
  assert.equal(rates.fundingRatePct, '-0.0639336');
  assert.equal(rates.netRatePct, '2.9360664');
});

test('a streamed market with no swap in the window earns nothing and pays its funding', () => {
  const rates = projectHlpVaultRates(metaVault({
    ylp: { market: 'M', swapRatePct: '0', interestRatePct: '0', growth: 'none' },
  }));
  assert.equal(rates.ylpGrowth, 'none');
  assert.equal(rates.swapRatePct, '0');
  assert.equal(rates.interestRatePct, '0');
  assert.equal(rates.netRatePct, '-0.2457112');
});

test('unread yLP growth is unknown, not zero', () => {
  const rates = projectHlpVaultRates(metaVault({ ylp: undefined }));
  assert.equal(rates.ylpGrowth, 'unknown');
  assert.equal(rates.swapRatePct, null);
  assert.equal(rates.fundingRatePct, '-0.2457112');
  assert.equal(rates.netRatePct, null);
});

test('unpriced yLP growth leaves the net rate unknown but keeps the funding cost', () => {
  const rates = projectHlpVaultRates(metaVault({
    ylp: { market: 'M', swapRatePct: null, interestRatePct: null, growth: 'recorded' },
  }));
  assert.equal(rates.swapRatePct, null);
  assert.equal(rates.fundingRatePct, '-0.2457112');
  assert.equal(rates.netRatePct, null);
});

test('an unreconciled or unpriced held vault has no leverage and no rates', () => {
  for (const input of [
    metaVault({ vault: { ...metaVault().vault, mintSupply: '199000000' } }),
    metaVault({ state: { ...metaVault().state, quoteSpotPriceNad: null } }),
  ]) {
    const rates = projectHlpVaultRates(input);
    assert.equal(rates.leverageBasis, 'vault');
    assert.equal(rates.leverageBps, '0');
    assert.equal(rates.swapRatePct, null);
    assert.equal(rates.fundingRatePct, null);
    assert.equal(rates.netRatePct, null);
  }
});

test('a failed rate read keeps the vault state and publishes null rates', async () => {
  const vault = metaVault().vault;
  const payload = { marketAddress: 'M', baseDecimals: 6, quoteDecimals: 6, targetHlpLeverageBps: 20000,
    state: metaVault().state, hlp: { schemaVersion: 'dusk-market-hlp.v1', base: { ...vault }, quote: { ...vault } } };
  const failed = await withHlpRates(payload, '1'.repeat(64), async () => { throw new Error('database down'); });
  const hlp = failed.hlp as Record<'base' | 'quote', Record<string, unknown>>;
  assert.equal(hlp.base.rates, null);
  assert.equal(hlp.base.lastNavNad, vault.lastNavNad);
  const served = await withHlpRates(payload, '1'.repeat(64), async (_identity, market) => {
    assert.equal(market.market, 'M');
    return { market: 'M', swapRatePct: '1', interestRatePct: '0.5', growth: 'recorded' };
  });
  assert.equal(((served.hlp as Record<'base', Record<string, { netRatePct: string }>>).base.rates).netRatePct, '2.7542888');
  assert.equal(await withHlpRates({ ...payload, hlp: null }, '1'.repeat(64)).then((value) => value.hlp), null);
});
