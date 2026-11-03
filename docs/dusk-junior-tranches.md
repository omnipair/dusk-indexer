# Dusk junior tranche read contract

This change indexes the tranche interface from Dusk PR #60 under the verified
`devnet-2026-11-01-tranches-fresh` deployment pin.

## Published market state

When the pinned Market account contains tranche fields, each market payload
adds `tranches` with:

- the active `jrLP` mint and generation;
- senior, junior, permanent and queued receipt balances;
- the current jrLP-to-reserve-share exchange rate;
- governed notice, exercise-window and request-fee settings;
- the recorded senior srLP rate and a transparent junior jrLP estimate.

The senior rate is a simple annualization of committed srLP growth over the
trailing seven-day window. The junior estimate applies the fixed 50/50 income
split to the live senior and junior capital bases. For example, equal income
over 80 senior shares and 20 junior shares makes the junior rate four times the
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
