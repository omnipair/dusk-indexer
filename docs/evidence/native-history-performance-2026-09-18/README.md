# Native wallet-history performance — 2026-09-18

This checks the native history path introduced by PR #12 against the practices
in `omnipair-indexer` main at `c950bc5e8d2e5edeb024cc2c45f330bc0505e255`.
The reference's activity controllers, migrations 009/017, cache invalidation,
`timedQuery` and activity benchmark informed the changes. Protocol identity,
canonical CPI provenance, native participant roles and keyset cursors remain
Dusk-specific. This is not a claim of whole-repository or search parity.

## Query and architecture mapping

| Reference practice | Native implementation |
| --- | --- |
| Wallet/market/order indexes | Migration 042 adds actor, distinct liquidator, market, slot/key and watermark indexes. |
| Filter before pagination; request one extra row | Each role branch applies canonical, window and cursor filters before `limit + 1`. A merge sorts at most twice that bound. |
| Short activity TTLs and shared requests | Reuses the existing native history cache: 128 entries, 20-second initial pages, 60-second cursor pages, shared in-flight work. |
| Event invalidation | Native notifications and listener reconnects clear pages. Every request also checks a transactionally maintained DB revision, so missed messages cannot serve stale data. |
| Query/cache observability | Shared `perfMetrics` records `dusk.history.events.state`, `dusk.history.events.page`, and hit/miss/coalesced outcomes. Existing HTTP middleware measures endpoint latency. |
| Reproducible benchmarks | `benchmark:native-activity` exercises the actual v2 HTTP endpoint or the actual database service with synthetic fixtures and query plans. |

The revision is updated once per mutating SQL statement, including bulk replay.
A finalized comparison-witness table detects contradictory observations on
write and permanently marks that identity conflicted. The witness is never used
as a selected event or a fork winner. Requests check this state before cache
access, instead of aggregating the full observation history on every page.

## Results

PostgreSQL 16.13 on the local Apple Silicon development host, 50,000 synthetic
events, 20 measured sequential requests, 50-row pages. Baseline code is PR #12
at `025912237e589bf59b9a8235baa736ebe126a709`, run against the same fixture and
migrated database (including the new indexes). Results were checked for exact
page equality before timing. [Raw results and plans](benchmark.json).

| Database service path | Median | p95 |
| --- | ---: | ---: |
| Original reader | 48.86 ms | 52.85 ms |
| Optimized, uncached | 1.35 ms | 1.54 ms |
| Optimized, cached, including DB revision check | 0.15 ms | 0.19 ms |
| Active wallet owning almost all events, uncached | 1.24 ms | 1.31 ms |

Twelve simultaneous cold reads executed one page query and twelve state checks.
Wallet, market, wallet+market and subsequent-cursor plans use the intended
indexes. The active-wallet plan asserts that stream-evidence checks remain
bounded by twice the page size rather than the wallet's entire event history.
Seeding the three source tables with the new write triggers took 11.18 seconds;
all synthetic inserts were rolled back.

These are database-service measurements, not production end-to-end latency.
They exclude HTTP transport, RPC deployment verification and network latency.
The HTTP benchmark is provided but was not run against this new build because
migration 042 has not been rolled out to devnet. Local Docker is unavailable,
so direct TimescaleDB runtime validation was not executed; PostgreSQL validation
and CI remain separate from that gate.

## Validation

- TypeScript build and 153 unit tests pass.
- Full rollback-only PostgreSQL integration suite: 90 tests pass, including
  14 native-history tests. These cover CPI pagination, owner/version/identity
  separation, duplicate participant roles, out-of-window rows, late replay,
  stream corruption, missed and received notifications, request coalescing,
  finalized promotion and concurrent contradictory finalized writes.
- A separate populated database was migrated from 041 to 042. Its original
  page remained exactly equal, and a pre-existing finalized conflict was
  backfilled as a halt. The ordinary migration runner then ran a second time
  successfully. [Upgrade check](upgrade-check.cjs).
- The live devnet fixture gate runs in the PR's existing native-integration CI;
  it is not replaced by synthetic database fixtures.

## Reproduce

Use a disposable database with the normal migration manifest applied. From the
repository root, save the original reader for comparison:

```sh
git show 0259122:api/src/services/duskEventHistory.ts > /tmp/dusk-history-baseline.ts
cd api
DUSK_ALLOW_DISPOSABLE_DB_TESTS=true \
BENCH_MODE=database BENCH_EVENTS=50000 \
BENCH_BASELINE_TS=/tmp/dusk-history-baseline.ts \
BENCH_OUTPUT=/tmp/dusk-history-benchmark.json \
npm run benchmark:native-activity
```

`DATABASE_URL` must point to that disposable database. The DB benchmark refuses
to seed without the explicit disposable flag and always rolls back. To measure
the deployed HTTP route after rollout, omit `BENCH_MODE` and provide
`API_BASE_URL` and `DUSK_HISTORY_OWNER`; `DUSK_HISTORY_MARKET` is optional.
The HTTP mode is read-only, shares a fixed `until` across identical requests,
and includes the live deployment brackets in its timings.

For the upgrade check, run the normal migration runner with a manifest ending
at 041 in a separate disposable database. Set `BENCH_BASELINE_TS` as above,
`UPGRADE_BASELINE_JSON` to a temporary file, and run `node
 docs/evidence/native-history-performance-2026-09-18/upgrade-check.cjs seed`
from the repository root. Apply the full manifest, then run the same helper
with `verify`. The helper deliberately commits only synthetic upgrade fixtures.

## Rollout

Apply migration 042 using the indexer's normal migration runner **before**
rolling out the new API. It backfills state/witnesses and creates indexes under
a write lock on the three source tables. Existing API versions remain compatible
with the additive schema. No program upgrade or frontend response-shape change
is required. Do not deploy the new API first or bypass deployment validation.
