# Combined layout-14 devnet candidate

Inactive candidate for Dusk PR #78 at `a99091ddfea26af1a1fe0c775d55b628beff5300`.
It combines #77's LP metadata repair, #78's junior exit cancellation/replacement
and #79's independent risk/utilization target bands. The generated IDLs are
copied byte for byte from that commit's Anchor build.

The recorded finalized deployment at slots 520157693/520158740 was verified
against the exact tested payloads plus zero allocation padding. It was then
superseded by another Dusk deployment at slot 520163931; the recorded evidence
is historical. It does not authorize activation or claim that the candidate is
currently deployed. Reverify both binaries and uploaded IDLs after release
coordination. SDK 2.19.0-next.20261109 is not published yet; no local tarball is
represented as a registry artifact.

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

1. Coordinate one stable combined deployment, then reverify exact executables
   and IDL accounts at finalized commitment.
2. Publish through the repository workflow and verify the real npm artifact,
   integrity and generated source/compiled interfaces before locking it.
3. Finish fresh market and junior bootstrap with dedicated-wallet cancellation
   and larger/smaller replacement acceptance. Capture fresh account/preview
   evidence under the new identity.
4. Archive the active lock, both IDLs, quote runtime, price references and
   deployment envelope. Start replay and new cursors under a new revision;
   preserve existing observations, projections and cursor identities.
5. Pass replay, quote-runtime parity, API integration and identity rejection
   gates before activating services or the frontend.
