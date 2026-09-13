import { BN } from '@coral-xyz/anchor';
import { loadPinnedProtocol } from '../config/duskProtocol';
import { PriceCaptureSource } from '../services/duskPrices';
import { checkpointFixture, encodeFixtureType, fixtureKey } from './duskYieldCheckpointFixtures';

export function priceFixture(options: { price?: string; quoteNad?: bigint; references?: boolean; effectiveFrom?: string } = {}) {
  const pin = loadPinnedProtocol(),fixture = checkpointFixture(),yieldSource = fixture.source();
  const references = { schemaVersion: 'dusk-price-references.v1',cluster: pin.cluster,programId: pin.dusk.programId,
    idlSha256: pin.dusk.idlCanonicalSha256,protocolRevision: pin.revision,effectiveFrom: options.effectiveFrom ?? '2026-09-01T00:00:00Z',
    references: options.references === false ? [] : [{ mint: fixtureKey(113).toBase58(),priceUsd: options.price ?? '1',note: 'Explicit fixture reference' }] };
  const source = (slot = 900000001): PriceCaptureSource => {
    const rawPreview = encodeFixtureType('MarketPreview',{ slot: new BN(slot),
      base: { live_reserve: new BN(0),cash_reserve: new BN(0),base_hlp_backing_inventory: new BN(0),quote_hlp_backing_inventory: new BN(0),
        ylp_supply: new BN(0),ylp_exchange_rate_nad: new BN(0),spot_price_nad: new BN((options.quoteNad ?? 2_500_000_000n).toString()),
        price_ema_nad: new BN(0),directional_price_ema_nad: new BN(0),conservative_depth_nad: new BN(0),borrow_index_nad: new BN(0),
        rate_at_target_nad: new BN(0),borrow_apr_nad: new BN(0),utilization_bps: new BN(0),fixed_debt: new BN(0),isolated_debt: new BN(0),
        hlp_funding_debt: new BN(0),total_debt: new BN(0),daily_borrow_limit: new BN(0),daily_borrow_remaining: new BN(0) } });
    return { market: yieldSource.market,slot,marketSlot: slot,blockhash: fixtureKey(130).toBase58(),blockTime: '2026-09-02T00:00:00.000Z',
      observedAt: '2026-09-02T00:00:05.000Z',deploymentIdentitySha256: 'b'.repeat(64),rawMarket: yieldSource.accounts.market!.data,
      rawPreview: rawPreview.toString('base64'),references };
  };
  return { source,references,baseMint: fixtureKey(112).toBase58(),quoteMint: fixtureKey(113).toBase58() };
}
