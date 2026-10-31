# Native program quote history

`GET /api/dusk/v1/history/quotes/:market` returns sampled program spot-price
candles inside the standard `dusk-deployment.v2` envelope. It does not return
trade candles, USD prices, or inferred reserve-ratio prices.

Required query parameter: `since` (ISO timestamp). Optional parameters:

- `until`: ISO timestamp, defaulting to request time. The interval is `[since, until)`.
- `side`: `base` (default) or `quote`. Each direction uses that side's saved
  `MarketPreview.spot_price_nad`; quote-side values are not computed by inverting
  the base-side value. The one exception is `openStart` (below), whose source
  event carries only the base side's start price.
- `resolutionSeconds`: 60 (default), 300, 900, 3600, 14400, or 86400. A request
  may intersect at most 2,000 buckets. Invalid selections return HTTP 400.

The price worker persists finalized simulation previews and projects their
relative quotes even if neither mint has a configured USD reference. Migration
036 adds the immutable quote projection. The existing price worker's ordinary
replay phase, including `--replay-only`, also projects older saved captures that
already have a completed USD projection. No historical RPC query or transaction
submission is needed for that replay.

Migration 037 publishes a native read-change notification when a relative quote
projection commits, including captures without USD valuation. Consumers can use
the [native read-change stream](dusk-read-change-stream.md) to request a fresh
history read; stream hints never supply chart prices directly.

Reads use a repeatable-read database transaction and the full configured
cluster/program/IDL/revision/deployed-binary identity. Captures before the pinned
release interval and captures of other deployment identities are excluded.
Migration 038 stores immutable capture deployment envelopes. Historical reads
can include registered captures from another API/worker build only when the
saved hash recomputes correctly and every program identity field matches the
active pin: network, genesis, both program/ProgramData addresses, deploy slots,
upgrade authorities, binary hashes, IDL hashes, schema and commitment. Unknown
hashes remain excluded. Live response envelopes and transaction checks still
use the full identity, including the API build revision.

The price worker registers its freshly observed envelope before saving a
capture. For captures predating migration 038, run
`node dist/scripts/registerDuskPriceDeployment.js <original-worker-build-revision>`
in the API service after migration. It observes the currently pinned program
accounts, reconstructs the original hash by replacing only the build revision,
and requires matching saved captures before registering the envelope. An
incorrect build or different program release cannot match. No capture, price
or projection is rewritten. Apply migration 038 before deploying this API or
price worker version. The same attestation matching applies to historical USD
prices used by market activity.

Contradictory finalized preview bytes, blockhashes, or block timestamps halt the
read. Duplicate captures of the same bank under different USD reference policies
count as one sample. The open and close use timestamp then slot ordering, so
arrival order cannot change candles when multiple banks share a second.

Each open/high/low/close includes an exact decimal price, capture ID, source
slot, actual observation timestamp, and saved source hash. Line charts can use
these timestamps when several samples share one candle bucket. The API rebuilds
each selected candle witness from its immutable, hashed Borsh bytes and checks
the materialized quote and mint bindings before returning it. Verified decoding
is memoized by a digest of **all** saved bytes, timestamps, identity and projection
fields, with a bounded ten-minute process cache; a claimed source hash alone
cannot produce a hit. NAD quotes are already normalized for mint decimals. Dividing by
1e9 is the only scale conversion; clients must not multiply by a token-decimal
difference. Prices remain decimal strings, preserving the full u64 range.

`coverage` distinguishes capture count, projected/pending captures, unique bank
samples, zero/unavailable quotes, source slots, and first/last capture time.
Zero quotes do not create zero-price candles, and empty buckets are not filled.
`historyRangeComplete`, `tradeOhlcAvailable`, and `gapsFilled` are always false.
`projectionComplete` only describes replay of saved captures; it says nothing
about uncaptured historical banks. The response also includes a SHA-256 digest
of the normalized selection, output, and coverage.

## Pre-trade open (`openStart`)

Live candles sample `SwapExecuted` snapshots (`streamed_market_snapshots`),
whose prices are post-swap, so a bucket's `open` already includes its first
swap's move. When no earlier sample precedes the bucket, as on a market's first
swap, the response does not show where that move started: on devnet market
`ogZU2fLhcSokMeaJGJBUDWzV3BLK4qHHsZhve64xhes` the first swap moved the price
from 0.999999999 to 1.01903572, and its candle opened at 1.01903572.

Each candle therefore also carries `openStart`, a witness with the same shape as
`open`. Its `captureId`, `sourceHash`, `time` and `sourceSlot` are identical to
`open`'s, because it describes the same capture; only `price` differs. On the
base side the price is the opening swap's `start_price_nad`, the base price it
was quoted at after any deferred controller step. On the quote side it is
`floor(1e18 / start_price_nad)`, the same inversion that gives the program's
quote-side spot price from its base-side one (quote spot 981319869 for base
spot 1019035720 on that market).

`openStart` is `null` when the bucket's opening sample carries no start price,
when that price is zero on the requested side, and on archived reads: saved
preview captures have no start price. The snapshot view does not expose
`start_price_nad`, so the read takes it from the opening sample's own event
observation, one primary-key lookup per bucket, and no migration is needed. The
field is additive: `schemaVersion` stays `dusk-quote-history.v1`, `basis` stays
`sampled-program-spot-quotes.v1`, and `open`, `high`, `low` and `close` keep
their meaning. The payload stream's `candles` frames carry the same candles.

## Time-series reads and incremental refresh

Apply migration `041_dusk_quote_series.sql` before deploying this API version.
It adds `dusk_ingestion.quote_series`, a seven-day Timescale hypertable when
the extension is installed (ordinary PostgreSQL remains supported for local
tests). It backfills the compact source coordinates/quote projection and installs
transactional triggers, so existing price-worker builds populate it immediately.
Immutable capture bytes remain in the original evidence tables. Pending captures
remain visible in the time-series projection and coverage.

The candle query selects one bounded time-series range for coverage, unique-bank
counts and OHLC witness selection; Timescale uses `time_bucket`. A serialized
protocol-scoped revision and conflict flag replace the per-request full-table
conflict scan. A contradiction stays a halt condition even outside the selected
market/window. Before-insert locking uses the price worker's existing lock order.

Completed candle computations have a bounded 32-entry, 15-second process cache,
with in-flight coalescing. Keys include the full response deployment identity,
registered historical identities, committed market revision, market, side, interval and
resolution. Each request reads its revision inside a repeatable-read transaction,
so a missed NOTIFY cannot retain an older projection. Responses still pass the
fresh RPC deployment bracket; deployment envelopes are never response-cached.

Full responses retain `dusk-quote-history.v1` and add `revision` (decimal string).
For subsequent refreshes send both `afterRevision` and `afterUntil` from the
previous accepted response, with the original `since` and a later `until`.
The response is `dusk-quote-history-update.v1` containing `request`,
`afterRevision`, `afterUntil`, `revision`, and `history` (a normal v1 history).
`history.window.since` is the oldest changed bucket, or the previous last bucket
when only the live tail needs refreshing. Delayed projections, out-of-order
backfills and registration of an older compatible deployment widen that suffix.
The minute change journal is transactional; capture ID allocation is not used as
a commit cursor. Revision allocation is serialized by protocol, while each
market uses its latest committed revision so unrelated markets cannot evict its
cached candles. A future/regressed revision returns HTTP 409.

Consumers validate the response scope, cursor, complete suffix and deployment
before replacing that suffix of their displayed history. They retain prior
candles only through a successful refresh and the normal freshness deadline.
An expired base, incomplete projection, side/resolution change or missing cursor
requires a full read. Notifications trigger the same refresh path as the bounded
polling fallback, preserving recovery when a stream disconnects.

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
not yet connected at that backend-validation point; no new signed transaction
was needed. The companion app subsequently connected native chart/headline
adapters and passed its range/direction and outage/recovery checks locally.
Publication and hosted acceptance of those app changes remain pending.
