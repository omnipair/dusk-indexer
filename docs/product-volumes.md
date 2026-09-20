# Product volumes

`GET /api/dusk/v1/analytics/activity` (the existing native activity endpoint) adds `volumes`
to both the response totals and each market. `spot`, `credit`, and `margin`
each contain exact decimal `observedUsd`/`valuedUsd`, observation counts,
unpriced counts, and `estimatedObservations`. The existing `metrics.volume`
remains the spot total. The deployment envelope and finalized-history coverage
continue to apply. These are overlapping product metrics, not additive parts
of a protocol-wide total.

| Product | Definition |
| --- | --- |
| Spot | AMM input valued once per executed swap, including leverage swaps. |
| Credit | Positive public-credit `MarketDebtUpdated.debt_delta`: new principal borrowed. Repayment, interest, margin debt, and hLP funding do not add credit volume. |
| Margin | Collateral exposure opened, increased, decreased, closed, or liquidated, valued in the collateral asset. Includes collateral supplied without a swap. Collateral-only deposits/withdrawals and debt-only repayment do not add trading volume. |

For example, an opening with $1,000 of existing collateral plus $2,000 swapped
borrowed principal has $3,000 margin volume and $2,000 spot volume, with no
credit-product volume. A later full close adds its closing exposure to margin.
The app must not sum the three categories.

The pinned IDL selects the spot source. The deployed pre-canonical revision
uses spot `SwapExecuted` plus embedded leverage receipts. An IDL containing
`SwapExecuted.origin` selects canonical swap events exclusively; lifecycle
receipts then supply margin exposure only. Updating the protocol pin still
requires the repository's normal compatibility review and replay. This PR
does not activate Dusk PR #35 or change the deployed IDL.

## Prices

The existing `start:prices-worker` now also persists provider observations in
the immutable, protocol-scoped `price_observations` table. No new database
migration or worker is required. The order for activity valuation is:

1. A captured Jupiter quote, with the existing Birdeye service as provider fallback.
2. The native program's decimal-normalized, curve-aware spot quote times the
   other asset's captured provider price.
3. The existing mint-specific devnet references and native on-chain ratio.

The Jupiter request uses [Price API V3](https://developers.jup.ag/docs/price).
`JUPITER_API_KEY` and `BIRDEYE_API_KEY` retain their existing meanings. Provider
timeouts, HTTP failures and unlisted mints leave the native fallback available.
Without a USD reference on either side, USD volume stays unknown; no token
symbol is assumed to mean one dollar.

Devnet provider prices require an explicit `externalMint` in the protocol's
price-reference file. Only wrapped SOL is mapped by default. The mapping is
deliberate reference pricing, not a claim that a devnet token has mainnet value;
the app marks it as estimated. Additional devnet mints remain on their configured
or on-chain fallback unless explicitly mapped.

Every event uses a prior-slot captured native quote and provider observations
recorded no later than that event, within the requested age bound. Fresh quotes
are never applied retroactively to old volume. Provider observation IDs and
native capture IDs participate in the selection hash. A missing historical
price remains unpriced; partial ingestion remains partial. Replay uses the
same canonical event keys, so running projection twice adds no volume.

Start the prices worker and market-activity worker with the same protocol pin
as the API, then deploy the companion webapp change. Existing finalized event
projections are sufficient to derive the new product totals; no reset is needed.
