# Dusk junior tranche read contract

This change indexes the tranche interface from Dusk PR #60 under the verified
`devnet-2026-11-01-tranches-fresh` deployment pin.

## Published market state

Every market payload publishes `srlpRates` independently of the optional jrLP
mint projection and the junior tranche's current backing.
The `dusk-srlp-rates.v1` object has basis `recorded-claimable-srlp-rate.v1`,
`annualization: simple-365-day`, `windowSeconds: 604800`, and `growth`,
`swapRatePct`, `interestRatePct`, and `totalRatePct`. It uses the same recorded
srLP growth as hLP and tranche rates. A failed read returns `srlpRates: null`;
unpriced components remain null, and `growth: none` is not measured zero yield.
These are claimable APR components, excluding compounded fees and unpaid interest.

The v1 `tranches` projection requires an initialized junior mint. When it is
unset, the API keeps `tranches: null`; this does **not** mean that junior capital
was never seeded. The initial liquidity deposit can create permanent junior
receipts independently of the jrLP mint, and those receipts can remain after
losses exhaust their backing. Clients must not infer absence of junior seed
accounting from a null mint or projection.

Clients use `srlpRates` for Market APY and show no junior estimate without a
usable tranche projection and positive junior backing. A junior estimation
failure leaves recorded senior rates available. A failed senior rate refresh
clears both `srlpRates` and `tranches.rates`, rather than retaining old estimates.
During rollout, clients may fall back to `tranches.rates.senior` only when the
standalone field is absent; explicit null means unavailable.

When the pinned Market account has an initialized junior mint, each market
payload adds `tranches` with:

- the active `jrLP` mint and generation;
- senior, junior, permanent and queued receipt balances;
- the current jrLP-to-reserve-share exchange rate;
- governed notice, exercise-window and request-fee settings;
- the recorded senior srLP rate and a transparent junior jrLP estimate.

The senior rate is a simple annualization of committed srLP growth over the
trailing seven-day window. The junior estimate applies the market's governed
income split to the live senior and junior capital bases. At a 50/50 split,
equal income over 80 senior shares and 20 junior shares makes the junior rate four times the
senior rate. These are historical market measurements, not promised APY or an
exact claim for a particular holder. Swap and interest stay separate so clients
can explain the estimate.

## Wallet state

`lpBalances` accepts a fourth kind, `junior`. A separate `juniorExits`
lane reports burned jrLP that is still first-loss capital while waiting for its
notice and exercise window. Cash withdrawal remains a different srLP action.

Every balance and exit is scoped to a `JuniorCohortInitialized` event. A new
generation after a wipe is therefore never netted against the retired mint.
Retired jrLP remains discoverable for historical yield claims.

## Rollout

The active lock starts at slot `517399749`, after both finalized programs were
available. The retired-address tranche lock and every earlier lock remain archived;
old observations keep their original program and revision identity. The promoted
review bundle contains the generated IDLs and exact SDK archive used by the API.
