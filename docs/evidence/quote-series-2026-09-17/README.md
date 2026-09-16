# Indexed, cached and incremental candles — 2026-09-17

Migration 041 was applied atomically to the `dusk-devnet` database with the
canonical ledger checksum and a five-second lock timeout. It copied all 12,742
captures, including pending projections, into the new Timescale hypertable.
Existing worker builds maintain it through transactional database triggers.
No original observations were changed or deleted. `migration.json` records the
applied checksum and row-count parity.

The API implementation at `7fb52d4e96827fd3e6619fe130ff31e27a97aeb9` is deployed
to Railway `dusk-api`, deployment `36a4e842-f388-4d73-b97d-3e291bc3dda9`.
The environment is named `production` inside the **devnet** project; cluster and
RPC identity remain devnet. The build-revision variable matches this commit.
The companion app adapter is in dusk-webapp PR #13, commit `e399273f`.

## Same-data comparison

`comparison.jsonl` was measured inside the API container in a separate Node
process with a repeatable-read, read-only transaction. The baseline is the
history implementation from `13f4425` (already using the shared Borsh decoder).
Each full result was deeply compared after removing only the new revision field
and its resulting selection hash. Candles, bindings, coverage and every source
witness were identical. Incremental output was checked against a separate full
query over the exact returned suffix. Validation queries are excluded from the
timed phase and its query list.

| Computation | 7R market | HYV market |
| --- | ---: | ---: |
| Previous history path | 523 ms | 393 ms |
| New series, cold decoder-result cache | 327 ms | 382 ms |
| New series, warm decoder-result cache | 139 ms | 131 ms |
| Complete result-cache hit | 13 ms | 7 ms |
| Incremental suffix | 25 ms | 25 ms |

Both full histories contained 230 candles. Incremental responses contained one
candle, reducing the application data from 188–197 KB to about 2.4 KB. Cache hits
still query the current conflict flag/market revision and historical deployment
registrations; no stale deployment envelope is reused. These are database and
verification timings, **not** HTTP or browser-load times.

## Actual app adapter

`app-7r.jsonl` and `app-hyv.jsonl` use the app's real protocol boundary and chart
source against the final deployed API and configured devnet RPC. Each process
performed a cold history read, full source read, then two incremental refreshes.
All eight reads succeeded and retained 231 displayed candles. Incremental HTTP
responses contained one candle. No wallet was used or transaction signed.

Cold reads were 5.0–5.5 seconds, full reads after warm-up 1.9–2.0 seconds, and
incremental reads 1.5–1.8 seconds including all before/after compatibility checks
and network trips. The remaining cold delay includes program-binary attestation.
This change does not claim reference-level initial-load latency or eliminate
RPC/provider outages. The app removes one redundant identity request while
keeping the boundary's fresh before/after observations and upgrade rejection.

## Validation

- API TypeScript build and 149 existing/new unit checks passed.
- All 19 price/history integration checks passed on a fresh, disposable local
  PostgreSQL database; the final market-revision refinement passed all 12 quote
  integration checks again. The deployed Timescale path additionally passed
  the same-data comparison on both markets.
- Coverage includes exact quotes in both directions, pending projections,
  same-bank deduplication, old-slot backfill, historical deployment registration,
  global finalized conflicts, immutable projection guards, forged witness
  rejection, missed notifications, cursor regression, and in-flight cache clearing.
- App validation: 152 quote/chart and required protocol gates, plus 12 token-icon
  checks; TypeScript and touched-file ESLint passed. A token icon now tolerates a
  missing loading-time symbol instead of crashing the whole page.

No program, SDK, keeper or transaction-builder change is required. Deploy the
additive migration before the API; full v1 responses remain compatible with old
clients. New clients fall back to full reads when the server lacks a revision.
