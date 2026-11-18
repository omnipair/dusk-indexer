import { canonicalJson, sha256 } from '../config/duskProtocol';

/** One-off legacy market scope. This module never constructs transactions. */
export const LEGACY_RETIREMENT = Object.freeze({
  market: '7xf68VEvMtLJ2Up5zVZdA161uH1yNkTFYgDFhNUSwkM7',
  program: 'DuskWhswJYrzABDn8GqQD191X9RobRi5jhgGntXEdnKj',
  delegate: 'DeLegABhDLREbDpwwcsbkHvDS5MwqKPAw1CJKoooUXFQ',
  revision: 'mainnet-2026-11-14',
  layout: 17,
});

export interface RetirementAccount {
  address: string;
  kind: string;
  state: Record<string, any>;
}
export interface RetirementReceipt {
  mint: string;
  supply: string;
  accounts: { address: string; owner: string; amount: string; frozen: boolean }[];
}

function atoms(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value))
    throw new Error('Invalid retirement token/share amount');
  return BigInt(value);
}

/** Enumerate all token accounts, including non-ATAs and protocol custody. Never
 * substitute largest-accounts results or an operator-supplied holder count. */
export function reconcileRetirementReceipts(receipts: RetirementReceipt[]) {
  const mints = new Set<string>(), addresses = new Set<string>();
  return receipts.map(receipt => {
    if (mints.has(receipt.mint)) throw new Error('Duplicate retirement receipt mint');
    mints.add(receipt.mint);
    let total = 0n;
    for (const account of receipt.accounts) {
      if (addresses.has(account.address)) throw new Error('Duplicate retirement token account');
      addresses.add(account.address);
      total += atoms(account.amount);
    }
    if (total !== atoms(receipt.supply)) throw new Error('Incomplete retirement receipt supply');
    return { mint: receipt.mint, supply: receipt.supply, enumeratedAmount: total.toString(),
      accounts: receipt.accounts.filter(account => atoms(account.amount) > 0n)
        .sort((a,b) => a.address.localeCompare(b.address)) };
  }).sort((a,b) => a.mint.localeCompare(b.mint));
}

export function retirementInventorySummary(accounts: RetirementAccount[], receipts: RetirementReceipt[]) {
  const markets = accounts.filter(account => account.kind === 'Market');
  if (markets.length !== 1 || markets[0].address !== LEGACY_RETIREMENT.market
    || markets[0].state.version !== LEGACY_RETIREMENT.layout)
    throw new Error('Retirement scope differs from the single legacy layout-17 market');
  const market = markets[0].state;
  const seen = new Set<string>();
  for (const account of accounts) {
    if (seen.has(account.address)) throw new Error('Duplicate retirement program account');
    seen.add(account.address);
    if (account.state.market && account.state.market !== LEGACY_RETIREMENT.market)
      throw new Error('Retirement account crossed market scope');
  }
  const requiredMints = [market.srlp_mint,market.junior_mint,
    market.base_side.hlp_mint,market.quote_side.hlp_mint,
    ...accounts.filter(account => /^(HlpCohort|JuniorCohort)$/.test(account.kind)).map(account => account.state.mint)];
  const reconciled = reconcileRetirementReceipts(receipts);
  if (new Set(requiredMints).size !== reconciled.length
    || requiredMints.some(mint => !reconciled.some(receipt => receipt.mint === mint)))
    throw new Error('Retirement receipt inventory omitted a current or retired mint');
  const owners = new Set<string>();
  for (const account of accounts) if (account.state.owner) owners.add(account.state.owner);
  const custodyAuthorities = new Set([LEGACY_RETIREMENT.market,...accounts.map(account => account.address)]);
  const receiptHolders = new Set<string>();
  for (const receipt of reconciled) for (const account of receipt.accounts) {
    if (!custodyAuthorities.has(account.owner)) {
      owners.add(account.owner);
      receiptHolders.add(account.owner);
    }
  }
  const counts: Record<string,number> = {};
  for (const account of accounts) counts[account.kind] = (counts[account.kind] ?? 0) + 1;
  const leverage = accounts.filter(account => account.kind === 'LeveragePosition');
  const borrow = accounts.filter(account => account.kind === 'BorrowPosition');
  return {
    market: LEGACY_RETIREMENT.market,
    counts,
    openLeveragePositions: leverage.filter(account => atoms(account.state.debt_shares) > 0n
      || atoms(account.state.collateral_amount) > 0n).length,
    openBorrowPositions: borrow.filter(account => ['fixed_base_shares','fixed_quote_shares','base_collateral','quote_collateral']
      .some(key => atoms(account.state[key]) > 0n)).length,
    owners: [...owners].sort(), receiptHolders: [...receiptHolders].sort(),
    receipts: reconciled,
    positions: [...leverage,...borrow].sort((a,b) => a.address.localeCompare(b.address)),
    // A coherent finalized clone plus actual settlement execution is needed for
    // net payouts. Token balances or today's USD mark are not entitlements.
    settlementReady: false as const,
    payoutPolicy: 'final-net-OMFG-META' as const,
    forcedClosuresRequested: true as const,
    blockers: ['legacy-retirement-instructions-not-implemented',
      'forced-unwind-pricing-and-slippage-not-approved',
      'permanent-seed-and-residual-disposition-not-approved',
      'terminal-snapshot-and-clone-settlement-not-rehearsed'],
  };
}

export function retirementObservationHash(value: unknown): string {
  return sha256(canonicalJson(value));
}
