# Combined layout-14 devnet candidate

Reviewed release candidate for merged Dusk PR #78 at `a99091ddfea26af1a1fe0c775d55b628beff5300`.
It combines #77's LP metadata repair, #78's junior exit cancellation/replacement
and #79's independent risk/utilization target bands. The generated IDLs are
copied byte for byte from that commit's Anchor build.

Both combined programs and uploaded IDLs are now finalized and verified at
slots 520272736/520273794, matching the exact tested payloads plus zero
allocation padding. The refreshed program PR deployment-match check passes.
Prior verification at slots 520157693/520158740 remains in deploymentHistory;
those records retain their original observations. PR #79 is closed as superseded
by the combined release.

The local release pin now selects this revision. SDK 2.19.0-next.20261109 was
published by the repository workflow on merged commit cc380898. Its registry
integrity and both packaged generated IDLs were verified; the archive SHA-256 is
`086ea70869c175e1fefcd5c062d693e92d699479dcc6602732ab0f857e14590a`.
Service activation follows CI and replay/compatibility checks.
The new revision's first slot is 520273795. Existing observations and cursors
remain scoped to their recorded identities.

## Live acceptance and captured observations

Both fresh markets are seeded and have initialized, funded junior tranches.
`fixtures/markets.json` contains public finalized account observations and
unsigned read-only market previews, with each source slot recorded separately.
Both markets report zero debt, 4% APR and the intended independent target bands.
The prior decoder fabricates debt from these same preview bytes and misreads the
new account's IRM half-life; regression tests retain that failure evidence.

`fixtures/junior-exits.json` records dedicated-wallet acceptance using the local
SDK built from the tested commit, funded with 0.4 devnet SOL. Finalized writes
cover early cancellation and atomic larger/smaller replacements. Each ready_at
exactly matches submission slot plus the full crowding-adjusted notice. Senior
balance and funded junior reserve shares remain unchanged during requests and
cancellations. One-shot simulations reject overwrites, zero requests and early
conversion. The final pending exit is cancelled. This is program/local-SDK
acceptance; published-SDK/frontend acceptance remains pending.
Finalized receipt balances also confirm that all 20,000 receipt units charged
as request fees remain paid after cancellation.

## Compatibility review

- Market layout changes from 13 to 14: the IRM's former single utilization cap
  is replaced by two u16 target bounds, adding two account bytes. Existing
  layout-13 accounts cannot be operated as layout 14. The user chose fresh
  markets with old accounts, positions and history retained as archives.
- Debt APR fields are renamed without changing their wire widths. PreviewSide
  removes the retired u128 rate-at-target field, shortening each side by 16
  bytes. The prior candidate's live preview regression demonstrates why the
  stale decoder fabricates debt. Preserve that historical fixture's identity.
- RiskRateConfig and RiskRateUpdate add the utilization band. Their transitive
  uses change initialize_market/announce_operator_change arguments, Market
  and OperatorProposal accounts, and MarketCreated/OperatorChangeAnnounced
  event bodies. Other direct event declarations and discriminators are
  unchanged. Replay must select the decoder by the complete revision identity;
  old event bytes cannot be decoded or relabeled with the new schema.
- RequestExit keeps its enum variant and u64 wire width but changes the argument
  to junior_amount. Its semantics require cancellation before a fresh nonzero
  request; in-place addition and zero renewal are gone. Early cancellation is
  allowed. Full notice restarts, capital stays junior until conversion, and
  an atomic failed replacement rolls back cancellation.
- update_lp_metadata adds an operator-authorized cosmetic metadata instruction.
  No market/mint accounting or authority can be changed by it.
- Current REST IRM terms use dual-target-bands.v1 and carry both utilization
  bounds. Archived junior-coverage.v1 and utilization.v1 DTOs retain their
  original meaning. Current controllers have no borrowing utilization cap.

## Activation still required

1. Program merge, workflow publication and registry artifact verification are
   complete. Both uploaded IDLs and exact tested executable hashes match devnet.
2. Archive the active lock, both IDLs, quote runtime, price references and
   deployment envelope. Start replay and new cursors under the new revision;
   preserve existing observations, projections and cursor identities.
3. Pass replay, quote-runtime parity, API integration and identity rejection
   gates before activating services or the frontend. Complete live frontend
   read/write acceptance using the published SDK and matching indexer revision.
