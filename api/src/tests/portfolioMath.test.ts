import test from 'node:test';
import assert from 'node:assert/strict';
import {
  allocateLpEarning,
  calculateValueDeltaUsd,
  reconstructTotalSupplyAtSlot,
  tokenRawToUsd,
} from '../utils/portfolioMath';

test('reconstructTotalSupplyAtSlot includes minimum liquidity and add/remove events', () => {
  const totalSupply = reconstructTotalSupplyAtSlot(
    [
      { slot: 10, liquidity: 9000, eventType: 'add' },
      { slot: 20, liquidity: 1000, eventType: 'remove' },
      { slot: 30, liquidity: 5000, eventType: 'add' },
    ],
    20
  );

  assert.equal(totalSupply, 9000);
});

test('allocateLpEarning splits token revenue by LP share', () => {
  const allocations = allocateLpEarning(
    [
      { signer: 'user-a', lpAmount: 2500 },
      { signer: 'user-b', lpAmount: 7500 },
    ],
    10000,
    100_000_000,
    200_000_000,
    { priceUsd: 1, decimals: 6, quality: 'historical' },
    { priceUsd: 2, decimals: 6, quality: 'historical' }
  );

  assert.equal(allocations.length, 2);
  assert.equal(allocations[0].token0Amount, 25_000_000);
  assert.equal(allocations[0].token1Amount, 50_000_000);
  assert.equal(allocations[0].totalUsd, 125);
  assert.equal(allocations[1].totalUsd, 375);
});

test('tokenRawToUsd applies token decimals', () => {
  assert.equal(tokenRawToUsd(1_500_000, { priceUsd: 2, decimals: 6, quality: 'current' }), 3);
});

test('calculateValueDeltaUsd returns current value minus net contributed value', () => {
  assert.equal(calculateValueDeltaUsd(125, 100), 25);
});
