# Wallet and market statistics payload streams

A wallet price change previously appeared one position at a time because each
position had its own HTTP valuation request and cache. Wallet snapshots publish
positions, valuations and conditional orders as one complete revision. The
webapp replaces a single cache entry so the rows and total update together.

## Contracts

`GET /api/dusk/v1/payload-snapshot` supplies an initial full snapshot.
`GET /api/dusk/v1/payloads` pushes subsequent full revisions as `dusk-payload`
SSE events. Both accept these additional selections:

| Selection                              | Payload                                                                                                                  | Capture cooldown | Evidence lifetime                        |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------- | ---------------------------------------- |
| `kind=wallet&owner=<canonical base58>` | `dusk-wallet.v1`: owner position accounts, all open-position valuation outcomes, exit/entry/hLP orders and trigger marks | 2 seconds        | 15 seconds                               |
| `kind=statistics&range=24h` or `all`   | `dusk-statistics.v1`: covered activity aggregates and complete per-market collateral exposure                            | 5 seconds        | 60 seconds for activity; 30 for exposure |

Capture duration is additional to the cooldown. A server hub checks for the next
revision once per second after the prior check completes. This is paced backend
capture delivered over a persistent connection, not a promise of one snapshot
per chain event. The existing public markets/trades/candles streams are unchanged.
The new selections use HTTP SSE directly; the existing gRPC proxy does not yet
accept these kinds and must not receive them.

Wallet captures discover complete owner-scoped position accounts, run at most
six exact full-close captures concurrently, capture orders, then recheck the
position inventory and amounts before publication. No partial valuation batch
is published. A confirmed custom rejection at the close instruction produces
`{status:"unavailable", reason:"close-rejected", address, sourceSlot}` for that
position. It is not a zero or an estimated PnL. Transport, identity and malformed
receipt failures reject the batch. The stored previous revision retains its
original expiration; repeated delivery never renews it.

Each successful valuation retains its original observation and verification
slots and includes the captured native market account bytes. Orders retain
native account, market and optional position bytes, avoiding lossy numeric
conversions and Anchor's fixed-size account-encoding buffer. Entry and hLP
trigger reads preserve the existing adapter's exact program previews. The
backend never signs or submits transactions. The frontend only decodes these
indexer payloads; cancellation/transaction preparation keeps its existing
independent verification and user signing flow.

This is atomic publication to consumers, not an atomic chain bank across
positions, order kinds and simulations. Per-observation slots remain explicit.
Exposure discovery rejects more than 10,000 accounts; wallet position and each
order-kind discovery reject more than 500. Existing stream limits remain: 16
active payload selections per API process, 128 total snapshot connections and
bounded write backlogs. Capacity errors remain explicit, without silently
truncating portfolios.

## Persistence and rollout

The existing `dusk_ingestion.live_snapshots` table and cross-process lock coalesce
capture work across replicas. Keys include deployment identity and exact wallet
or statistics selection. No migration, new daemon, gRPC change or new secret is
required; migration 043 must already be applied. Existing `DUSK_PREVIEW_PAYER`
or the deployment upgrade authority supplies a public simulation payer.

1. Merge and deploy this indexer API update.
2. Verify one wallet snapshot, statistics snapshot and SSE revision sequence.
3. Publish the companion webapp #39 change after those endpoints are available.

The old per-owner account and per-position valuation routes stay available for
existing clients. Deploying the frontend first would make these migrated
surfaces unavailable because it intentionally has no browser-RPC fallback.

## Validation

API unit coverage includes bounded batch completion/draining, changed inventory,
explicit quote unavailability, market exposure identity, nonempty order wire
serialization and invalid stream selections. A disposable PostgreSQL integration
checks cross-connection sharing, failed-capture retention and unchanged expiry.
Frontend tests cover six-position atomic cache replacement, partial-frame
rejection, stale bootstrap races, wallet changes, identity/mutation boundaries,
statistics coverage, SSE selection and shared subscriptions.

Live hosted validation and signed transaction gates must be reported separately;
unit and disposable-database results do not establish deployed stream behavior.


## Leverage capital basis and history cutoffs

Wallet snapshots add `cashFlows` for each positive-collateral leverage position,
including debt-free positions. Canonical opening/update/liquidation events are
read under one database snapshot and pinned protocol identity. The account's
`openedSlot` identifies its generation; latest event post-state must match the
observed account. Missing/lagging history, ambiguous same-slot reuse and
contradictory state yield `status: "unavailable"` without hiding the position.
No browser chain reads or new program accounts are needed.

The `entry-margin-owner-flows.v1` basis starts at credited opening margin, adds
subsequent gross `owner_debit`, and totals net `owner_credit` plus liquidation
owner surplus. Keeper rewards are not owner capital flows. Marked equity plus
withdrawals minus contributions is lifetime position PnL in debt tokens; it
excludes network/order fees and does not alter the account's entry margin,
liquidation health or protocol debt. The legacy oracle `pnlRaw` remains its
entry-equity delta for rolling compatibility; consumers needing cash-flow
adjusted PnL must use the explicit cash-flow basis. Migration 050 adds a scoped
observation index; canonical rollback remains authoritative, with no separate
contribution ledger to repair.

Event, order and quote histories accept an upper cutoff up to 1,000 ms ahead
of server time to tolerate small client clock skew. They retain the exact
requested cutoff in cursor scope; clamping to a changing server clock would
invalidate subsequent pages. Larger future cutoffs and malformed ranges remain
invalid. This tolerance is not a claim of complete coverage through that time.

Committed yield-growth decoding uses the SDK's `MARKET_LAYOUT_VERSION` (6 for
this release), rejecting retired and future layouts. No program or IDL changes
are introduced by these fixes.

Local validation: 268 API unit tests and 103 rollback-only PostgreSQL integration
tests pass, including canonical rollback, PDA reuse, contribution/withdrawal
math, unknown-history fallback and stable cutoff cursor scope.


Closed-position selection requires `position_state.closed` for flash/emergency
settlements, as well as leverage ownership, before pagination. Partial recovery
remains activity and does not masquerade as a fully closed position. The
companion webapp recognizes both settlement events without inventing an AMM
swap receipt for an external fill.
