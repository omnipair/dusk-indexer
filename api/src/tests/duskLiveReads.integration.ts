/** Disposable PostgreSQL only: every fixture rolls back. Discovery for the
 * live reads comes from streamed events and delegate instructions. */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { PoolClient } from 'pg';
import pool from '../config/database';
import { loadPinnedProtocol } from '../config/duskProtocol';
import { readStreamedBorrowPositions } from '../services/duskBorrowValuation';
import { readOpenEntryOrderAddresses } from '../services/duskEntryOrderBook';
import { readStreamedHlpBalances } from '../services/duskHlpPositions';
import { readOwnerGovernanceSupports, readStreamedMarketMints } from '../services/duskOwnerGovernance';
import { readOwnerYieldGroups } from '../services/duskOwnerYield';
import { readStreamedReferralState, referralPartnerAddress } from '../services/duskReferralPartner';
import { fixtureMarket, key, streamedEvent, streamedIdentity, streamedMarket, streamedRelease } from './duskStreamedFixtures';

if (process.env.DUSK_ALLOW_DISPOSABLE_DB_TESTS !== 'true' || !process.env.DATABASE_URL)
  throw new Error('Set DUSK_ALLOW_DISPOSABLE_DB_TESTS=true and a disposable DATABASE_URL');
after(() => pool.end());

const pin = loadPinnedProtocol();
const delegateIdentity = [pin.cluster, pin.leverageDelegate.programId, pin.leverageDelegate.idlCanonicalSha256, pin.revision];
const { market, baseMint, quoteMint, ylp, baseHlp, quoteHlp } = fixtureMarket;
const owner = key(201),
  other = key(202);

async function transaction(work: (client: PoolClient) => Promise<void>) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const identity of [streamedIdentity, delegateIdentity])
      await client.query(`INSERT INTO dusk_ingestion.protocol_identities(cluster,program_id,idl_hash,protocol_revision)
        VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`, identity);
    await streamedRelease(client, { slot: 900_500_000, time: new Date(Date.now() - 1000) });
    await work(client);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
let nextSlot = pin.historyFirstSlot + 10;
/** One delegate instruction, as the daemon records it. */
async function instruction(client: PoolClient, name: string, named: Record<string, string>, path = [0]) {
  const signature = Array.from(randomBytes(88), (byte) => ALPHABET[byte % 58]).join('');
  const slot = nextSlot++;
  const ok = await client.query('SELECT dusk_ingestion.record_order_instruction($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) AS ok', [
    ...delegateIdentity, [...delegateIdentity, signature, path.join('.')].join('|'), signature, slot, '3'.repeat(44),
    1_790_000_000 + slot - pin.historyFirstSlot, path, name, named.order, named.owner ?? named.order_owner, named.market ?? null,
    Buffer.from([1]), JSON.stringify({ accounts: { named, all: Object.values(named) }, arguments: {} }),
  ]);
  assert.equal(ok.rows[0].ok, true);
}

test('borrow discovery keeps open positions, per owner or with debt, dated by the stream', () => transaction(async (client) => {
  const health = { global_health_base_contribution_for_quote_debt: '5', global_health_quote_contribution_for_base_debt: '0',
    base_liquidation_cf_bps: '8000', quote_liquidation_cf_bps: '8500' };
  const open = async (position: string, holder: string, shares: string) => {
    await streamedEvent(client, 'MarketCollateralDeposited', { market, position, owner: holder, base_collateral: '10',
      quote_collateral: '0', auction_debt_asset: '255', ...health });
    await streamedEvent(client, 'MarketDebtUpdated', { market, position, owner: holder, fixed_base_shares: '0',
      fixed_quote_shares: shares, auction_debt_asset: '255', ...health });
  };
  await open(key(211), owner, '5');
  await open(key(212), owner, '0');
  await open(key(213), other, '9');
  await open(key(214), owner, '7');
  await streamedEvent(client, 'MarketDebtUpdated', { market, position: key(214), owner, fixed_base_shares: '0',
    fixed_quote_shares: '0', auction_debt_asset: '255', ...health });
  await streamedEvent(client, 'MarketCollateralWithdrawn', { market, position: key(214), owner, base_collateral: '0',
    quote_collateral: '0', closed: true, ...health });
  const mine = await readStreamedBorrowPositions({ owner }, client);
  assert.deepEqual(mine.positions.map((row) => row.address).sort(), [key(211), key(212)].sort());
  assert.equal(mine.sourceSlot, 900_500_000);
  const indebted = await readStreamedBorrowPositions({ withDebt: true }, client);
  assert.deepEqual(indebted.positions.map((row) => `${row.address}:${row.owner}`).sort(), [`${key(211)}:${owner}`, `${key(213)}:${other}`].sort());
}));

test('hLP holdings are the owner\'s non-zero hLP balances by vault side', () => transaction(async (client) => {
  await streamedMarket(client);
  await streamedEvent(client, 'LiquidityAdded', { market, owner, ylp_amount: '1000' });
  await streamedEvent(client, 'HlpOpened', { market, owner, asset_side: '0', hlp_amount: '40', ylp_amount: '1' });
  await streamedEvent(client, 'HlpOpened', { market, owner, asset_side: '1', hlp_amount: '15', ylp_amount: '1' });
  await streamedEvent(client, 'HlpClosed', { market, owner, asset_side: '1', hlp_amount: '15', ylp_amount: '1' });
  const { balances, sourceSlot } = await readStreamedHlpBalances(owner, client);
  assert.deepEqual(balances, [{ market, side: 'base', hlpMint: baseHlp, amount: '40' }]);
  assert.equal(sourceSlot, 900_500_000);
}));

test('open entry orders are created orders whose latest lifecycle instruction is still their creation', () => transaction(async (client) => {
  const create = (order: string, where = market) => instruction(client, 'create_leverage_entry_order', { market: where, order, owner });
  await create(key(221));
  await create(key(222));
  await instruction(client, 'cancel_leverage_entry_order', { order: key(222), owner });
  await create(key(223));
  await instruction(client, 'execute_leverage_entry_order', { order: key(223), market, owner });
  await create(key(224), key(230));
  // The same order id reused after a cancel is open again.
  await create(key(225));
  await instruction(client, 'cancel_leverage_entry_order', { order: key(225), owner });
  await create(key(225));
  assert.deepEqual((await readOpenEntryOrderAddresses(market, client)).sort(), [key(221), key(225)].sort());
}));

test('governance supports fold a proposer\'s sponsorship, later supports and withdrawals per proposal', () => transaction(async (client) => {
  await streamedMarket(client);
  const proposal = key(240),
    elsewhere = key(241);
  await streamedEvent(client, 'ParameterProposalCreated', { proposal, market, proposer: owner, initial_support: '25', status: '0' });
  await streamedEvent(client, 'ParameterProposalSupported', { proposal, supporter: other, amount: '60', supporter_locked: '60', total_locked: '85', status: '0' });
  await streamedEvent(client, 'ParameterProposalCreated', { proposal: elsewhere, market: key(242), proposer: other, initial_support: '5', status: '0' });
  await streamedEvent(client, 'ParameterProposalSupported', { proposal: elsewhere, supporter: owner, amount: '30', supporter_locked: '30', total_locked: '35', status: '0' });
  await streamedEvent(client, 'ParameterProposalSupported', { proposal, supporter: owner, amount: '10', supporter_locked: '35', total_locked: '95', status: '0' });
  let result = await readOwnerGovernanceSupports(owner, null, client);
  assert.deepEqual(result.supports, [
    { proposal, market, lockedAmount: '35' },
    { proposal: elsewhere, market: key(242), lockedAmount: '30' },
  ].sort((a, b) => a.market.localeCompare(b.market)));
  assert.equal(result.sourceSlot, 900_500_000);
  await streamedEvent(client, 'ParameterProposalSupportWithdrawn', { proposal, supporter: owner, amount: '35', total_locked: '60', status: '0' });
  result = await readOwnerGovernanceSupports(owner, market, client);
  assert.deepEqual(result.supports, []);
  assert.deepEqual((await readOwnerGovernanceSupports(other, market, client)).supports, [{ proposal, market, lockedAmount: '60' }]);
  assert.deepEqual(await readStreamedMarketMints(market, client), { ylpMint: ylp, baseMint, quoteMint });
  assert.equal(await readStreamedMarketMints(key(242), client), null);
}));

test('a referral partner\'s terms and accruals come from its own events', () => transaction(async (client) => {
  await streamedMarket(client);
  const partner = referralPartnerAddress(owner).toBase58(),
    otherPartner = referralPartnerAddress(other).toBase58();
  const accrual = key(250),
    second = key(251);
  assert.equal((await readStreamedReferralState(owner, client)).partner, null);
  await streamedEvent(client, 'ReferralPartnerConfigured', { referral_partner: partner, authority: owner, recipient: key(252),
    interest_share_bps: '1500', active: true, signer: owner });
  await streamedEvent(client, 'ReferralRecipientUpdated', { referral_partner: partner, authority: owner, recipient: key(253) });
  await streamedEvent(client, 'ReferralInterestAccrued', { market, referral_partner: partner, referral_accrual: accrual, accrued_amount: '100' });
  await streamedEvent(client, 'ReferralInterestAccrued', { market, referral_partner: partner, referral_accrual: accrual, accrued_amount: '40' });
  await streamedEvent(client, 'ReferralInterestClaimed', { market, referral_partner: partner, referral_accrual: accrual, remaining_accrual: '0' });
  await streamedEvent(client, 'ReferralInterestAccrued', { market, referral_partner: partner, referral_accrual: accrual, accrued_amount: '7' });
  await streamedEvent(client, 'ReferralInterestAccrued', { market, referral_partner: partner, referral_accrual: second, accrued_amount: '3' });
  await streamedEvent(client, 'ReferralInterestAccrued', { market, referral_partner: otherPartner, referral_accrual: key(254), accrued_amount: '9' });
  const state = await readStreamedReferralState(owner, client);
  assert.deepEqual(state.partner, { authority: owner, recipient: key(253), interestShareBps: 1500, active: true });
  assert.deepEqual([...state.accruals.entries()].sort(), [[accrual, 7n], [second, 3n]].sort());
  assert.deepEqual(state.markets, [{ market, baseMint, quoteMint }]);
  assert.equal(state.sourceSlot, 900_500_000);
}));

test('yield discovery covers every held LP, including emptied holdings, and escrows until their yield settles', () => transaction(async (client) => {
  await streamedMarket(client);
  await streamedEvent(client, 'LiquidityAdded', { market, owner, ylp_amount: '10' });
  await streamedEvent(client, 'LiquidityRemoved', { market, owner, ylp_amount: '10' });
  await streamedEvent(client, 'HlpOpened', { market, owner, asset_side: '1', hlp_amount: '4', ylp_amount: '1' });
  const hlpOrder = (order: string, target: string) =>
    instruction(client, 'create_hlp_order', { market, target_hlp_mint: target, order, owner });
  await hlpOrder(key(261), baseHlp);
  await hlpOrder(key(262), quoteHlp);
  await instruction(client, 'execute_hlp_order', { order: key(262), market, order_owner: owner });
  await hlpOrder(key(263), quoteHlp);
  await instruction(client, 'cancel_hlp_order', { order: key(263), owner });
  await instruction(client, 'settle_hlp_order_yield', { order: key(263), market, owner });
  const { groups, sourceSlot } = await readOwnerYieldGroups(owner, client);
  assert.deepEqual(groups.map((group) => `${group.holder}:${group.lpMint}:${group.kind}`).sort(), [
    `${owner}:${quoteHlp}:hlp`, `${owner}:${ylp}:ylp`, `${key(261)}:${baseHlp}:hlp`, `${key(262)}:${quoteHlp}:hlp`,
  ].sort());
  assert.ok(groups.every((group) => group.market === market && group.baseMint === baseMint && group.quoteMint === quoteMint));
  assert.equal(sourceSlot, 900_500_000);
  await hlpOrder(key(264), key(265));
  await assert.rejects(readOwnerYieldGroups(owner, client), /unknown vault/);
}));
