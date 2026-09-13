import { BN, BorshCoder } from '@coral-xyz/anchor';
import { PublicKey } from '@solana/web3.js';
import { AccountLayout, AccountState, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { loadPinnedProtocol } from '../config/duskProtocol';
import { duskRawIdl } from '../services/duskMarketSimulation';
import { PortfolioCaptureSource } from '../services/duskPortfolioSnapshots';
import { checkpointFixture, encodeFixtureAccount, encodeFixtureType, fixtureKey } from './duskYieldCheckpointFixtures';
import { priceFixture } from './duskPriceFixtures';

export function portfolioFixture(options: { slot?: number; lpOwner?: string; lpAmount?: bigint; closed?: boolean; previewUnavailable?: boolean; references?: boolean } = {}) {
  const pin = loadPinnedProtocol(),fixture = checkpointFixture(),original = fixture.source(),market = fixture.market;
  const slot = options.slot ?? 910_000_001,marketAddress = original.market,owner = fixture.owner;
  const decoder = new BorshCoder(duskRawIdl());
  const preview = decoder.types.decode('MarketPreview',Buffer.from(priceFixture().source(slot).rawPreview,'base64')) as any;
  const debt = market.debt as any;
  debt.base_borrow_index_nad = new BN(1_100_000_000); debt.quote_borrow_index_nad = new BN(1_000_000_000);
  for (const side of ['base','quote']) {
    const raw = market[`${side}_side`] as any,reserve = new BN(side === 'base' ? '100000000000' : '250000000');
    raw.reserves.live_reserve = reserve; raw.reserves.cash_reserve = reserve; raw.shares.ylp_supply = new BN(1000);
    Object.assign(preview[side],{ live_reserve: reserve,cash_reserve: reserve,ylp_supply: new BN(1000),
      borrow_index_nad: debt[`${side}_borrow_index_nad`],spot_price_nad: new BN(side === 'base' ? '2500000000' : '400000000') });
  }
  const positionId = fixtureKey(172),[position,bump] = PublicKey.findProgramAddressSync([Buffer.from('borrow_position_v2'),new PublicKey(marketAddress).toBuffer(),positionId.toBuffer()],new PublicKey(pin.dusk.programId));
  const positionState = { market: new PublicKey(marketAddress),owner: new PublicKey(owner),position_id: positionId,bump,
    base_collateral: new BN(1_000_000_000),quote_collateral: new BN(0),fixed_base_shares: new BN(200_000_000),fixed_quote_shares: new BN(0) };
  // Deliberately not an ATA: all LP token accounts participate in ownership.
  const tokenAddress = fixtureKey(173).toBase58(),token = Buffer.alloc(AccountLayout.span);
  AccountLayout.encode({ mint: market.ylp_mint as PublicKey,owner: new PublicKey(options.lpOwner ?? owner),amount: options.lpAmount ?? 100n,
    delegateOption: 0,delegate: fixtureKey(0),state: AccountState.Initialized,isNativeOption: 0,isNative: 0n,
    delegatedAmount: 0n,closeAuthorityOption: 0,closeAuthority: fixtureKey(0) },token);
  const source: PortfolioCaptureSource = { schemaVersion: 'dusk-portfolio-capture.v1',maxCatalogAgeSlots: 750,
    catalog: { accountScanId: '1',accountSlot: slot-1,lpScanIds: ['1','2','3'],lpScanSlots: [slot-1,slot-1,slot-1],sourceFloor: slot-1,
      markets: [marketAddress],knownOwners: [owner],items: [
        { address: position.toBase58(),market: marketAddress,owner,kind: 'borrow',sourceSlot: slot-1 },
        { address: tokenAddress,market: marketAddress,owner,kind: 'ylp',sourceSlot: slot-1 }] },
    groups: [{ market: marketAddress,slot,blockhash: fixtureKey(174).toBase58(),blockTime: '2026-09-02T00:00:00.000Z',
      observedAt: '2026-09-02T00:00:05.000Z',deploymentIdentitySha256: 'b'.repeat(64),
      marketAccount: { owner: pin.dusk.programId,executable: false,data: encodeFixtureAccount('Market',market).toString('base64') },
      preview: options.previewUnavailable ? null : encodeFixtureType('MarketPreview',preview).toString('base64'),
      basis: options.previewUnavailable ? 'rpc-account' : 'simulation-post-state',previewUnavailable: options.previewUnavailable ?? false,
      accounts: [
        { address: position.toBase58(),account: options.closed ? null : { owner: pin.dusk.programId,executable: false,data: encodeFixtureAccount('BorrowPosition',positionState).toString('base64') } },
        { address: tokenAddress,account: options.closed ? null : { owner: TOKEN_2022_PROGRAM_ID.toBase58(),executable: false,data: token.toString('base64') } }] }],
    references: priceFixture({ references: options.references }).references,observedAt: '2026-09-02T00:00:05.000Z',deploymentIdentitySha256: 'b'.repeat(64) };
  return { source,owner,tokenAddress,position: position.toBase58() };
}
