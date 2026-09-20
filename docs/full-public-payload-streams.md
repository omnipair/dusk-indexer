# Full public payload streams

The API now captures shared market state, the latest public market events, and
bounded candle windows once per selection. gRPC-Web `StreamDuskPayloads` delivers
those full snapshots instead of asking each browser to fetch them after hints.
The API also exposes the same stream at `/api/dusk/v1/payloads` for SSE clients.

Selections are `markets`, `trades` with a market, and `candles` with a market,
base/quote side and one of the existing six candle resolutions. No arbitrary
owner, URL, page size or SQL range is accepted. Events are limited to 100 and
candles to 2,000 buckets. Older history remains available through cursor APIs.

Market/event captures have a two-second minimum interval; candles five seconds.
The API process shares each producer and PostgreSQL coordinates replicas using
the existing `live_snapshots` table. Unsubscribing the last consumer stops work.
Streams have bounded topic/client counts, backpressure disconnects and a 2 MiB
frame cap in gRPC. Full snapshots recover without an unbounded replay log.
Original observation time, expiry, source slot and deployment identity survive
cache hits. The client still verifies the deployment against RPC before accepting
display data, and transactions still require fresh SDK/RPC verification.

## VOB repair and SDK provenance

Both consumers vendor `dusk-sdk-2.10.1-devnet.20260918.tgz`, SHA-256
`c1c4faf5079cf728d1a1e4f54e79c5675684e4e2c959af4594733c7ff00a0b08`.
This starts from the reviewed 2.10.0 archive (`db3d0ce`) and applies only the
projection fix from Dusk PR #38 (`6ef059c`). Its IDLs/generated types remain
byte-for-byte compatible with the pinned deployed program. Current SDK main
contains a newer interface; substituting that package fails deployment checks.

CPMM sampling now uses the live reserve product instead of assuming cached
liquidity remains an exact invariant after integer rounding. Displayed prices,
size-dependent surcharge, base/transfer fees and impact still come from native
swap previews. Concentrated range sampling is preserved. Shared producer
failures emit a bounded reason code without logging RPC URLs or credentials.

## Rollout and validation

Review SDK PR #38, then deploy this API and gRPC change before the webapp payload
consumer. No program upgrade, new migration or ingestion daemon change is needed.
Keep the chart-refresh PR #26 when merging the webapp's stacked consumer PR.

Validated: API unit suite (179 tests); gRPC suite (9 tests), including a real
localhost SSE bridge with fragmented frames and sequence-gap rejection; unsigned
VOB simulations on both reported markets (12 bids and asks each); live capture of
4 markets, 10 public events and 185 candles from existing devnet data. Captured
payloads are also checked by the webapp's existing strict parsers. The upstream
SDK fix passed all required CI gates and 93 LiteSVM tests; the compatible package
passed its 29 applicable SDK preview tests.

Browser traffic reduction across the newly deployed stack is a post-deployment
check; the backend has not been deployed by this task. No signed live transaction
was submitted. This public-data stage does not replace owner-specific position,
balance or PnL preview reads. Those require a separate wallet payload contract;
initial loading, older pagination, exact trade previews and write checks also
continue to use HTTP/RPC intentionally.
