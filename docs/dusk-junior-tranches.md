# Dusk junior tranche read contract

This change indexes the tranche interface proposed in Dusk PR #60 without
activating an undeployed protocol revision.

## Published market state

When the pinned Market account contains tranche fields, each market payload
adds `tranches` with:

- the active `jrLP` mint and generation;
- senior, junior, permanent and queued receipt balances;
- the current jrLP-to-reserve-share exchange rate;
- governed notice, exercise-window and request-fee settings;
- the recorded senior yLP rate and a transparent junior jrLP estimate.

The senior rate is a simple annualization of committed yLP growth over the
trailing seven-day window. The junior estimate applies the fixed 50/50 income
split to the live senior and junior capital bases. For example, equal income
over 80 senior shares and 20 junior shares makes the junior rate four times the
senior rate. These are historical market measurements, not promised APY or an
exact claim for a particular holder. Swap and interest stay separate so clients
can explain the estimate.

## Wallet state

`lpBalances` accepts a fourth kind, `junior`. A separate `juniorExits`
lane reports burned jrLP that is still first-loss capital while waiting for its
notice and exercise window. Cash withdrawal remains a different yLP action.

Every balance and exit is scoped to a `JuniorCohortInitialized` event. A new
generation after a wipe is therefore never netted against the retired mint.
Retired jrLP remains discoverable for historical yield claims.

## Rollout

The active deployment lock is unchanged. The candidate bundle contains the
generated Dusk and leverage-delegate IDLs plus the exact SDK archive. Promotion
still requires verified program deployment, protocol identity promotion,
replay of the new event folds, and the usual compatibility checks.
