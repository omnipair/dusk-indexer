# Native program quote history

`GET /api/dusk/v1/history/quotes/:market` returns sampled program spot-price
candles inside the standard `dusk-deployment.v2` envelope. It does not return
trade candles, USD prices, or inferred reserve-ratio prices.

Required query parameter: `since` (ISO timestamp). Optional parameters:

- `until`: ISO timestamp, defaulting to request time. The interval is `[since, until)`.
- `side`: `base` (default) or `quote`. Each direction uses that side's saved
  `MarketPreview.spot_price_nad`; quote-side values are not computed by inverting
  the base-side value.
- `resolutionSeconds`: 60 (default), 300, 900, 3600, 14400, or 86400. A request
  may intersect at most 2,000 buckets. Invalid selections return HTTP 400.

The price worker persists finalized simulation previews and projects their
relative quotes even if neither mint has a configured USD reference. Migration
036 adds the immutable quote projection. The existing price worker's ordinary
replay phase, including `--replay-only`, also projects older saved captures that
already have a completed USD projection. No historical RPC query or transaction
submission is needed for that replay.

Reads use a repeatable-read database transaction and the full configured
cluster/program/IDL/revision/deployed-binary identity. Captures before the pinned
release interval and captures of other deployment identities are excluded.
Contradictory finalized preview bytes, blockhashes, or block timestamps halt the
read. Duplicate captures of the same bank under different USD reference policies
count as one sample. The open and close use timestamp then slot ordering, so
arrival order cannot change candles when multiple banks share a second.

Each open/high/low/close includes an exact decimal price, capture ID, and saved
source hash. The API rebuilds each selected candle witness from its immutable,
hashed Borsh bytes and checks the materialized quote and mint bindings before
returning it. NAD quotes are already normalized for mint decimals. Dividing by
1e9 is the only scale conversion; clients must not multiply by a token-decimal
difference. Prices remain decimal strings, preserving the full u64 range.

`coverage` distinguishes capture count, projected/pending captures, unique bank
samples, zero/unavailable quotes, source slots, and first/last capture time.
Zero quotes do not create zero-price candles, and empty buckets are not filled.
`historyRangeComplete`, `tradeOhlcAvailable`, and `gapsFilled` are always false.
`projectionComplete` only describes replay of saved captures; it says nothing
about uncaptured historical banks. The response also includes a SHA-256 digest
of the normalized selection, output, and coverage.

Consumers must label these as sampled program prices, retain missing-history
states, and bind caches to the entire deployment identity. The latest historical
close is not a fresh executable quote. Current price displays and every write
still require fresh, compatible SDK/RPC reads. Before connecting the app chart,
its legacy decimal adjustment, reserve-based live ticks, and retained animation
layers must be replaced or guarded at the native adapter boundary.

Validation on 2026-09-14: 124 API unit tests and 58 rollback-only database checks
passed. The live devnet worker captured all four discovered markets. Both quote
directions for the dedicated unpriced market returned HTTP 200 at source slot
497984848, and four invalid selections returned HTTP 400. The browser chart is
not yet connected to this endpoint; no new signed transaction was needed.
