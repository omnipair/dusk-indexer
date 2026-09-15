# Recorded yLP earnings rates

`GET /api/dusk/v1/analytics/yield-rates?since=<ISO>&until=<ISO>` returns recorded
claimable swap-fee and interest rates for native Dusk yLP shares. `market` is an
optional public market address. The interval must be 1 hour to 90 days.

The response uses `dusk-yield-rates.v1` inside the standard freshly verified
`dusk-deployment.v1` envelope. The rate basis is
`recorded-claimable-ylp-rate.v1`, with simple 365-day annualization. These values
are **APR components, not total APY**. `fullApyAvailable` is false. Unpaid debt
interest, compounded principal and protocol revenue are not included.

For each boundary, the reader selects the latest committed Market account at or
before the requested time, at most 15 minutes old. Both boundaries must exist.
It revalidates the immutable yield-checkpoint evidence, including account owners,
PDAs, source hash and full pinned deployment. A conflicting finalized Market
snapshot halts the read, including a conflict in an unprojected observation.
Market accounts returned by unsigned preview simulations are never earnings
snapshots: their hypothetical accrual is not a committed entitlement.

The difference in each swap/interest Q64 growth index is the earned raw token
amount per raw yLP share. The reader values this difference using the latest
verified prior-slot USD reference capture within one hour of the end snapshot.
It divides by the starting share value (starting live reserves, starting prices
and starting supply) and by the actual elapsed snapshot time. Token decimals
remain exact; a change in ending supply does not change the starting holder's
per-share earnings. The response includes the actual window, source slots,
content hashes, price reference hashes and exact growth deltas.

Missing prices or zero starting capital/supply produce null rates. A measured
no-growth period produces zero. Missing or stale snapshot brackets omit the
market from measured results; callers must keep that market's rate unavailable.
No owner's address, YieldAccount address or LP balance is returned.

Yield-checkpoint capture now registers its RPC-verified deployment in
`capture_deployments` before saving an observation. This allows compatible API
builds to reuse history while rejecting changes to either program's binary,
IDL, deployment slot or authority. Existing unregistered historical hashes are
not silently trusted or rewritten.

Validation uses the native account fixtures and rollback-only PostgreSQL tests
in `duskYieldRateMath.test.ts` and `duskYieldRates.integration.ts`. This endpoint
does not complete the app's total-APY display or historical compounding allocator.
