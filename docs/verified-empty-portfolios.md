# Current portfolios between releases

A stream with no discovered market is not evidence that every wallet is empty.
After completed legacy retirement, the successor can legitimately have no market
until a user creates one. The portfolio worker must support that interval without
carrying forward an old nonzero balance or manufacturing a zero during stream lag.

For an empty discovery catalog the worker verifies the RPC genesis, exact code,
ProgramData allocation/slot/authority and uploaded IDL for both pinned programs,
performs a full finalized Market-discriminator scan, fetches that exact block's
hash/time, then verifies both executables and IDLs again. The full scan is saved
as an immutable observation before asserting absence. A nonempty scan stops
capture until normal discovery catches up. Same-slot contradictory finalized
catalogs, or absence contradicting captured Market bytes, halt projection and
history reads; both observations remain available.

Only a verified empty scan permits capture v4. It names its prior catalog
observation and exact full identity. It contains no market/account groups and
projects zero protocol positions and zero unclaimed income. Released tokens in
wallets remain outside the portfolio's existing positions-only scope. Raw capture
is committed before its projections, using the existing snapshot writer/replay.
No historical price, balance, cursor or event is relabeled.

Previously registered, byte-verified history revisions may supply wallet
addresses for this empty interval. Their positions and balances do not enter the
current decoder. Current zero checkpoints retain those wallets after the next
market is created; normal nonempty discovery remains scoped to the active pin.
Stored historical checkpoints remain readable under their original identity.

Apply migration `060_dusk_empty_portfolio_catalogs.sql` before deploying the API
or portfolio worker. It is additive and changes no active protocol lock, SDK,
cursor, canonical event or on-chain state. This feature does not replace receipt
reconciliation for actual retirement payouts, and it does not infer a zero while
the temporary retirement executable differs from the active normal pin.

Validation: API TypeScript build, complete API unit and rollback-only PostgreSQL
integration suites, including finalized contradictions, saved proof binding,
verified historical-owner scope, stream lag, and the genuine empty interval.
