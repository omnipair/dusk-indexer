# Accrued-interest candidate (market layout 19)

The two generated IDLs come from the Dusk accrued-interest rewrite on base
commit `633287d47d022f2177d96be45fa937287042f5a6`. Borrower interest is credited to holders at accrual through
growth indexes and a per-asset `InterestLedger` in `Fees`; claims are paid from
reserve cash, limited by the cash present. The income receivable books,
`IncomeEpoch`, `roll_income_epoch`, `checkpoint_income`, `fund_interest`, the
public interest advance and the per-asset interest vaults are removed.

Interface changes the decoder and API account for:

- `Market` layout 19: `MarketSide.interest_vault` and `Market.income` are gone;
  `Fees` gains `ledger` and loses `public_interest_advance`,
  `interest_vault_balance`, `interest_liability`, `unallocated_interest_liability`
  and `revenue_interest_liability`. `HlpVault` loses its srLP interest
  checkpoints: vault interest is published to its holder index at accrual.
  It gains `held_base_interest` and `held_quote_interest`: a frozen vault
  holds its public interest for its creditors instead of publishing it. Held
  interest is the vault's, counted as recovery at a terminal close and
  published to holders only if the vault unfreezes. Market is 4,478 bytes.
- `YieldAccount` loses `income` and `income_initialized`;
  `OperatorRevenueAccount.claimable` is `[u128; 2]`; `JuniorCohort` loses
  `income_end`.
- Events: `BorrowInterestAccrued` adds `protocol_credit`, `operator_credit`,
  `lp_credit` and `vault_netted`; `BorrowInterestPaid` and
  `ReferralInterestAccrued` drop `interest_vault_credit`; `YieldClaimed` adds
  `interest_remaining`. `PublicInterestFunded` and `HlpInterestAllocated` are
  removed.
- Errors: `IncomeEpochNeedsRollover` and `IncomeHistoryRequired` are removed and
  later codes move down by two; `InterestDeficit` is added.

The candidate is undeployed and does not replace the active lock, its IDLs,
compatible deployment, quote runtime or price references. Activation is a new
revision with fresh cursors: promote the lock, compatible deployment, IDLs,
quote-runtime artifact and manifest, and price-reference identity together,
and bump the API to an SDK release whose bundled IDLs match these hashes.

Only decoder fixtures and pure candidate arithmetic are staged here. Active
API accounting, owner income archives, portfolio replay and rate semantics remain
on the current pin. Their layout-19 wiring is a separate coordinated cutover;
merging this preparation does not activate the candidate or change live reads.
