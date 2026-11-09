import test from 'node:test';
import assert from 'node:assert/strict';
import { marketConfigPayload } from '../services/duskMarketService';

const signals = {
  lowerSignalNad: '50000000', upperSignalNad: '62500000',
  halfLifeMs: '1209600000', initialAprNad: '40000000',
};

test('layout-14 rates expose both target bands without advertising a borrow admission cap', () => {
  const projected = marketConfigPayload({ config: { irm: {
    ...signals, lowerUtilizationBps: 7500, upperUtilizationBps: 8000,
  } } });
  assert.deepEqual(projected.irm, {
    model: 'dual-target-bands.v1', ...signals,
    lowerUtilizationBps: 7500, upperUtilizationBps: 8000,
  });
  assert.equal('borrowUtilizationLimitBps' in (projected.irm as object), false);
});

test('raw Anchor field names carry the same utilization band and partial bands fail closed', () => {
  const raw = { lower_signal_nad: '50000000', upper_signal_nad: '62500000',
    lower_utilization_bps: 7500, upper_utilization_bps: 8000,
    half_life_ms: '1209600000', initial_apr_nad: '40000000' };
  const irm = marketConfigPayload({ config: { irm: raw } }).irm as Record<string, unknown>;
  assert.equal(irm.lowerUtilizationBps, 7500);
  assert.equal(irm.upperUtilizationBps, 8000);
  const { upper_utilization_bps, ...partial } = raw;
  assert.throws(() => marketConfigPayload({ config: { irm: partial } }), /Incomplete/);
});

test('the preceding controller remains distinguishable for archived layout-13 state', () => {
  const irm = marketConfigPayload({ config: { irm: {
    ...signals, borrowUtilizationLimitBps: 8000,
  } } }).irm as Record<string, unknown>;
  assert.equal(irm.model, 'junior-coverage.v1');
  assert.equal(irm.borrowUtilizationLimitBps, 8000);
  assert.equal(irm.lowerUtilizationBps, undefined);
});
