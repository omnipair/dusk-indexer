# Shared market display snapshots

The virtual order book is computed once per deployment, market and grouping,
then delivered to every subscriber by the API. It uses the same reviewed Dusk
SDK 2.9.0 as dusk-webapp, including the program's size-dependent swap surcharge
and Token-2022 output transfer fees. The SDK IDL digest must match the vendored
protocol lock before computation. Native computation was ported from webapp
commit 1834248f; the browser's original implementation remains a diagnostic
reference and is no longer called by its VOB hook.

## Scheduling and fan-out

`GET /api/dusk/v1/virtual-book/:market/stream?groupingBps=10` serves named
`dusk-virtual-book` SSE frames. Supported groupings are 5, 10, 25, 50 and 100 bps.
Each connection receives a new stream UUID and consecutive sequence numbers.
The first published frame is a complete snapshot; reconnects need no delta log.
Frames contain the strict `dusk-deployment.v2` envelope plus a
`dusk-virtual-book.v1` payload with revision, capture time, expiry, actual source
slot range, token bindings, and fee-inclusive book levels.

One in-process topic serves every client with the same selection. PostgreSQL
transaction-scoped advisory locks and `dusk_ingestion.live_snapshots` coordinate
API replicas. Competing replicas return the current snapshot while a producer
is busy. They never run another simulation for that selection. PostgreSQL time
decides when the next capture is due. Failure also records a shared cooldown.
A crashed connection automatically releases its transaction lock.

`DUSK_VIRTUAL_BOOK_INTERVAL_MS` defaults to 2000 and accepts 1000–5000. This is the
minimum delay after a completed capture, not a claim to sample every Solana
block. Topics check shared storage at most once per second after each completed
read, with no overlapping reads. This interval also updates values affected by
elapsed time when market accounts are quiet. Sampling stops when the last local
subscriber disconnects; another replica with subscribers may continue.

Each complete book uses a market preview plus at most six four-quote native
simulation batches. Bank state/epoch/start-price consistency, mint ownership,
output transfer fees, deployment checks and the maximum eight-slot batch span
are preserved. A snapshot expires 20 seconds after the bank request started;
cache hits, delivery envelopes and SSE heartbeats never extend its lifetime.
Clients still independently verify deployment identity through RPC. These
snapshots are display-only and cannot enable or construct a transaction.

Capacity is bounded to 16 active selections and 128 streams per API process.
Slow streams close instead of buffering. Captures time out; retries reconnect
with a full snapshot. API shutdown closes its snapshot streams. Rows are
replaceable ephemeral state, never canonical history or ingestion coverage;
operators may prune rows older than one day using the indexed `updated_at`.

## Rollout

1. Apply `database/migrations/043_dusk_live_snapshots.sql` to the API database.
   It is also included in the daemon's migration manifest and Docker context.
2. Deploy the backend image containing the vendored SDK and new SSE route.
   Check reverse-proxy streaming/CORS and the database connection budget.
3. Deploy the matching webapp change. There is deliberately no fallback that
   resumes browser VOB simulations when the backend route is unavailable.

The existing gRPC/SSE change-notification stream remains unchanged for other
read families. The VOB subscribes directly to the native API SSE endpoint even
when gRPC is configured. No new background worker deployment is required.

## Extending the pattern

`sharedDuskSnapshot` is reusable storage/coordination; each domain must supply a
validated capture and bounded cadence. Do not put arbitrary client trade sizes
into unbounded shared-cache keys.

| Domain | Current source | Next use of this pattern |
| --- | --- | --- |
| VOB, concentration and size-dependent fees | Shared native preview batches | Implemented here |
| Spot/EMA prices, APR, utilization, debt health | `duskMarketService` already produces native market previews with a short per-process cache | Publish one shared market snapshot and migrate market-list consumers together |
| Pool TVL and aggregate displays | Market projection plus indexed/public price inputs | Share by deployment/market; preserve independent source timestamps |
| Candle and transaction history | Durable indexer projections | Stream committed revisions; keep pagination and coverage checks |
| Balances/position valuation | Owner-scoped RPC/previews | Share only within the same owner/position identity and freshness policy |
| Exact quotes and writes | Native request-specific previews and full write attestation | Keep fresh for the requested amounts/accounts, whether initiated on FE or BE |

## Validation on 2026-09-20

- TypeScript build and 168 backend unit tests pass.
- Disposable PostgreSQL integration: 30 competing connections perform exactly
  one computation; subsequent reads reuse the immutable snapshot; expiry allows
  one new computation. Failure cooldown passes separately.
- Ten real SSE clients on each of two devnet markets received one revision from
  exactly one capture. Regular market `45qXC…PBhL`, slot 501209883; Token-2022
  transfer-fee market `HuQok…mjSjL`, slot 501211503. Both bid and ask outputs
  matched separate native SDK previews within two raw units.
- Saved native-batch tests reject stale slots, mismatched amounts, programs,
  accounts and truncated logs. Stream tests cover 100 subscribers, coalescing,
  disconnect, upgrade, backpressure, and no overlapping captures.
- Probes submit no signed transactions. Live concentrated/nonzero-surcharge
  markets, hosted proxy/load testing and rollout remain unexecuted gates.
