import { fixtureKey } from './duskYieldCheckpointFixtures';
import { priceFixture } from './duskPriceFixtures';

export const activityMarket = priceFixture().source().market;
export const activityTime = '2026-09-02T00:00:10.000Z';
export const activitySlot = 900000010;
export const activityReceipt = () => ({
  asset_in_side: '0',fee_asset_side: '1',amount_in: '2000000000',
  amount_out: '4800000',gross_amount_out: '5000000',amount_in_after_fee: '2000000000',
  base_fee: '100000',divergence_fee: '20000',volatility_fee: '10000',
  retained_fee: '10000',compounded_fee: '50000',claimable_fee_credit: '69000',
});
export function activityPayload(name = 'SwapExecuted',slot = activitySlot): Record<string,unknown> {
  const common = { market: activityMarket,collateral_asset_mint: priceFixture().baseMint,collateral_amount: '3000000000',collateral_sold: '1000000000',collateral_delta: '1000000000',borrowed_amount: '2000000',debt_delta: '2000000',metadata: { market: activityMarket,slot: String(slot),signer: fixtureKey(121).toBase58() } };
  if (name === 'SwapExecuted') return { market: activityMarket,trader: fixtureKey(121).toBase58(),...activityReceipt() };
  if (name === 'HlpClosed' || name === 'HlpTerminalLiquidated')
    return { ...common,asset_side: '0',target_asset: '0',interest_paid: '250000' };
  return { ...common,swap: activityReceipt(),interest_paid: '250000',debt_asset_mint: priceFixture().quoteMint };
}
