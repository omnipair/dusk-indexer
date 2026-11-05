# Market preview failing

## Recognise it

`/status` returns 503 with `market-preview` in `degraded`.
`marketPreviews.failing` names each market with the `reason` and `errorName`
its `previewMarket` simulation failed with. `/markets/state` carries the same
reason on that market as `state.previewFailure`, next to
`previewStatus: "unavailable"`.

In the app the market has no prices: its USD figures read as a dash. With
`oracle-stale`, the liquidity sheet, the trade form and the market page say
"Price feed is stale", and their deposit, withdrawal and swap buttons are
disabled.

`market-state` in `degraded` is a different failure: the market surface
itself could not be read, and `marketPreviews.error` says why. Every client
read of `/markets/state` fails with it, so the app cannot load markets at all.
Read the API's logs.

## Why it happens

The API previews every market by simulating `previewMarket`. When that fails,
the market is still listed from its raw account, without anything the
preview supplies: prices, rates, health and debt.

- `oracle-stale`: the program's `OracleStale` (6148). The market's oracle
  report is older than its staleness limit. On devnet the report comes from
  the synthetic publisher, `dusk-devnet/dusk-prices`. On 2026-11-04 its wallet
  fell below the rent floor and stopped refreshing META/USDC for about 22
  hours.
- `program-error`: any other error the program returned. `errorName` is its
  IDL name when it is the program's own code, and null for Anchor's codes.
- `simulation-error`: the simulation failed outside the program, for example
  on a missing account or a compute-budget instruction.

## What it breaks

That market's valuation in the app and API. With `oracle-stale`, every
price-sensitive instruction also fails on chain: swaps, borrows, liquidity
changes, collateral withdrawals, leverage actions and liquidations.
Repayments and collateral top-ups still work. Other markets are unaffected.

## Do

- `oracle-stale` on devnet: read the publisher's logs (`dusk-prices`) for the
  refresh error, and fund its wallet if it is below the rent floor. It
  refreshes on its next tick.
- `oracle-stale` on mainnet: the feed itself stopped. Governance can replace
  the source, or set the oracle weight to zero to return the market to native
  pricing. That proposal is exempt from the utilization guard.
- `program-error`: open the runbook for that error name if one exists, such as
  [Swaps reverting](swaps-reverting.md) for `BrokenInvariant`.
- `simulation-error`: check the RPC first, using
  [RPC provider outage](rpc-provider-outage.md).

## Over when

`/status` drops `market-preview` from `degraded`, and the market's
`previewStatus` on `/markets/state` is `available` again. The app picks prices
up with its next market read.
