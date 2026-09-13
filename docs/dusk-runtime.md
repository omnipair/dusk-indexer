# Dusk runtime entrypoints

Build the daemon from the repository root with `cargo build --locked -p dusk-indexer-daemon`, or use `Dockerfile.dusk-indexer`. The Railway configuration in `indexer/railway.toml` assumes the repository root is its build context. The daemon starts through `scripts/dusk-indexer-entrypoint.sh`; `Dockerfile.indexer` and the `omnipair-carbon-indexer` executable remain reference code and are not Dusk deployment entrypoints. Commit the tested workspace `Cargo.lock` with dependency changes; the deployment build requires it.

The Dusk HTTP API uses `Dockerfile.dusk-api` and `api/dist/index.js`. `DATABASE_URL`, `DUSK_CLUSTER` and `DUSK_RPC_URL` must describe the intended deployment. The API no longer supplies a default database/password. Live deployment must pass a direct RPC comparison against both program binaries in `protocol/protocol.lock.json`.

The active identity is `(cluster, program_id, canonical_idl_sha256, protocol_revision)`. `devnet-2026-09-13-9973dea` identifies the merged and upgraded devnet release. Raw source hashes remain independently checked. Old cursors and records cannot be reused under the new identity. Both the daemon and API require the pinned ProgramData addresses, deploy slots, authorities and binary payloads; matching bytecode alone cannot authorize another deployment under the same revision.

## Deployment intervals

The composite release starts at slot **497831835**, the slot after the later of the Dusk and delegate upgrades. At startup the daemon verifies both complete program payloads in one finalized bank after that boundary. Later checks verify the fixed loader links, deploy slots and authorities. Account scans request a minimum context slot and require a subsequent attestation at or beyond the captured bank.

Migration 034 records the immutable deployment pin and first slot, plus an upper bound advanced only from direct finalized attestation. Signature pagination stops at the deployment floor, defers transactions newer than the pass's attested bank, and checks ordering and duplicate signatures. Decoding, event persistence and cursor advancement enforce the interval. Database triggers reject mismatched program/IDL identities or out-of-range slots for registered revisions. Registration and observations share transaction locks, so a concurrent observation cannot evade the initial check. Contaminated existing current-revision history blocks registration; it is not relabelled or deleted. Historical identities remain intact.

An empty new-release history creates a cursor at the first deployment slot with no fabricated last signature. A heartbeat reports polling only; it does not prove gap-free historical coverage. Missing archive data and prior-release reconstruction remain separate concerns.

Run one finalized ingestion pass against the configured database:

```sh
target/debug/dusk-indexer-daemon --ingest-once
```

`npm run test:deployment-integration --prefix api` checks registration, immutable identity, boundary slots, contaminated history, cursor guards and concurrent writes in a disposable PostgreSQL database. All fixtures roll back. Native adapter tests also require fresh `--scan-accounts-once` and LP ownership captures under the current pin. CI provisions PostgreSQL, applies the checksummed manifest, captures read-only devnet discovery, runs the native tests and builds both service images. The container checks verify that every manifest migration and both pinned IDLs are actually present in the images.

## Migrations

`database/dusk-migrations.txt` is the only automatic migration manifest. It excludes the destructive reset SQL and the old retention policy. Both generic database scripts delegate to this manifest. The runner holds a PostgreSQL advisory lock, records checksums, stops on SQL errors and refuses altered applied migrations. It can adopt an existing foundation schema from the pre-ledger bootstrap.

Run migrations without starting the daemon:

```sh
DUSK_MIGRATE_ONLY=true bash scripts/dusk-indexer-entrypoint.sh
```

Migration 024 removes old event retention jobs. Until historical projections and archive coverage are complete, pruning the event stream would change the compatibility views' balances. A new retention policy must establish durable current state, completed historical allocation, and a replay/archive boundary first.

## Native account projections

Each complete finalized RPC scan records its containing block and immutable account bytes before applying native projections. A lagging block-history replica receives four bounded retries at the exact account-bank slot; another slot cannot supply the missing block metadata. Closure tombstones are generated only from a successful complete scan; partial RPC failures cannot close accounts. Older replay does not overwrite newer current state. Contradictory finalized observations halt ingestion.

The one-shot scan command verifies the chain and both programs, stores a complete account scan, then exits:

```sh
target/debug/dusk-indexer-daemon --scan-accounts-once
```

Native discovery is exposed at `/api/dusk/v1/accounts/:kind`, where kind is `markets`, `borrow`, `leverage`, `yield`, or `orders`. Optional owner/market filters use native addresses. Records include the full identity, finalized source slot, containing blockhash, and observed time. Missing scan coverage returns an error instead of an authoritative empty portfolio. Clients must re-read RPC state before writes.

Program-account projections and finalized LP token ownership observations are available. Run `npm run start:lp-ownership-worker --prefix api -- --once` after a complete program scan to capture every LP token account and reconcile balances against mint supply. These point-in-time observations cover transfers and non-ATAs for discovery. Yield entitlement uses the canonical owner ATA required by the protocol, not the sum of arbitrary token accounts.

## Yield payment history

Migration 028 adds immutable history tables. The finalized claim projector, recorded-growth yield checkpoint worker, native price worker and portfolio capture worker are implemented locally. The legacy compatibility views must not be treated as native historical truth.

After the migration manifest has completed, build the API and run the claim worker:

```sh
npm run build --prefix api
npm run start:yield-claims-worker --prefix api -- --once
```

Omit `--once` to poll every ten seconds, or set `DUSK_YIELD_CLAIMS_INTERVAL_MS` (minimum 1000). `railway.yield-claims.toml` defines the worker service. It requires `DATABASE_URL` and the same checked `protocol/` artifacts as ingestion. It reads already-attested finalized events and never signs or contacts a wallet. Apply migrations before starting it; it does not change the database schema itself.

Each bounded transaction selects unprojected `YieldClaimed` events through the full protocol identity and finalized canonical pointer. A PostgreSQL transaction lock serializes replicas. There is no monotonic slot cursor that could skip a later backfill at an older slot. Missing or contradictory event-time records and malformed values fail the batch without advancing it. Database guards bind every immutable projection to its exact observation, payload, blockhash and block time. Successful inserts notify native read consumers.

`GET /api/dusk/v1/owners/:owner/yield-claims` accepts optional `market`, `since`, `until`, `limit` and `offset`. It returns exact decimal-string payments, the earning owner, delegated caller, recipient, mint, and full finalized provenance. Gross swap-fee/interest yield and net recipient credit remain separate for transfer-fee tokens. The route uses the deployment envelope and fresh identity boundary.

Coverage reports indexed/projected/pending claim counts for the protocol identity. `projectionComplete` means all currently indexed finalized claims are projected; it does not prove historical ingestion coverage. `ingestionRangeComplete` and `accrualHistoryAvailable` remain false. An empty result must not be rendered as proof that the owner earned or claimed zero. Claimed cash flow is not event-time earned yield, and current LP balances or current token prices are never substituted for historical observations.

## Recorded yield checkpoints

Migration 029 adds immutable account evidence for checkpoint replay and binds each projection to its exact source bytes. Build the API after applying the migration manifest, then run:

```sh
npm run start:yield-checkpoints-worker --prefix api -- --once
```

Omit `--once` to capture every 60 seconds, or set `DUSK_YIELD_CHECKPOINT_INTERVAL_MS` (minimum 1000). `railway.yield-checkpoints.toml` defines the service. Each pass first replays saved, unprojected observations in bounded transactions. `--replay-only` drains the saved backlog and exits without contacting RPC. Replay never uses a high-water slot cursor; older observations inserted later remain discoverable. Invalid or contradictory finalized evidence stops the worker and remains stored for investigation.

Capture discovers yield accounts through finalized RPC, then reads each yield account, its market and its owner's canonical Token-2022 LP ATA together in a single RPC bank. It attests the deployment before and after these reads. Block-history lag retries the same finalized slot; another block or wall-clock time cannot replace its timestamp. Raw evidence is committed before projection. Missing canonical ATAs contribute zero LP balance while preserving already accrued earnings.

`GET /api/dusk/v1/owners/:owner/yield-checkpoints` accepts optional `market`, `limit` and `offset`. It returns exact recorded swap-fee and interest amounts, LP balance, fractional remainders, decimals, and full finalized account/deployment provenance. It validates account owners, market/yield PDAs, LP mint bindings and token-account ownership before accepting a projection. Contradictory finalized observations make history unavailable instead of selecting the first arrival.

The `recorded-growth.v1` basis settles stored growth indexes only. It does not simulate fresh market interest or the hLP vault's lazy harvest of underlying yield. `currentHarvestPreviewIncluded` and `historyComplete` therefore remain false. These checkpoints are observations from capture onward, not historical event-time earnings or a current claimable quote. The client must use the SDK and fresh RPC simulation for current transaction amounts.

## Dated price observations

Migrations 030 through 032 add immutable market-preview evidence, bounded replay, price notifications and market-state provenance. After applying the manifest and building the API, run:

```sh
npm run start:prices-worker --prefix api -- --once
```

Omit `--once` to capture every minute; `DUSK_PRICE_INTERVAL_MS` sets the interval (minimum 1000). `--replay-only` projects saved captures without contacting RPC. `railway.prices.toml` defines the worker. Its permissions are read-only on devnet and write access to the projection database; it never signs or submits transactions.

`protocol/devnet-price-references.json` carries the existing webapp's three explicit devnet display references, with a full protocol identity, effective date and source notes. They are configured demo valuations, not external market prices. Override the path with `DUSK_PRICE_REFERENCES_FILE` when using another reviewed policy. A program/IDL/revision change requires deliberately updating this policy's identity. Each capture saves the complete dated policy and its hash, so changing the file later cannot reprice saved captures. Values are not inferred from token symbols or a token's position as a market's quote asset.

The worker discovers finalized market accounts and simulates the program's `preview_market` at a finalized bank. It validates market PDAs, the preview's embedded slot and both deployment identities, then preserves the updated simulated market account and preview return bytes from that same bank. The `simulation-post-state` basis requires `market_slot=slot`; earlier `rpc-account` captures retain their original evidence and content hashes. Simulation updates are not submitted to the chain. A configured value prices that specific mint; when only its counterasset has a reference, the program's curve-aware spot quote derives an estimated reference. Token decimal differences are already accounted for by the program quote. Arithmetic uses integers and decimal strings, with derived prices rounded down to 36 decimal places. It does not substitute a reserve ratio for a concentrated curve's price.

Missing references produce a completed capture with zero prices, not zero-valued tokens. A market-local simulation error is reported as unavailable coverage; contradictory finalized previews halt replay and history reads. Multiple slots sharing a block timestamp remain separate observations. Database guards bind prices to the capture coordinates, saved reference policy and arithmetic, and all price rows are immutable.

`GET /api/dusk/v1/prices/:mint` accepts `market`, `at`, `maxAgeSeconds` (1–86400, default 3600), `limit` and `offset`. It returns observations at or before `at` within the age limit, preserving configured/derived quality, exact prices, reference evidence and finalized source slots under a fresh deployment envelope. Results do not imply one globally authoritative USD price across markets. Missing or stale prices return an empty observation list and `available: false`; an unknown price must remain unknown in portfolio totals. Coverage is from capture onward. The worker cannot reconstruct historical curve previews for uncaptured devnet slots, so `historyComplete` and `historicalBackfillAvailable` remain false. The old mutable anchor table and compatibility price views are not inputs to this pipeline.

## Verification

Rust unit tests:

```sh
cargo test -p dusk-indexer-foundation -p dusk-indexer-daemon
```

After applying the manifest to a disposable PostgreSQL database, run `database/tests/native-account-projections.sql` with `psql -v ON_ERROR_STOP=1`. It checks idempotence, account closure, out-of-order replay, and finalized conflict rejection. The API's existing checks run through `npm run test:unit --prefix api`.

With `DATABASE_URL` pointing to a disposable database and `DUSK_ALLOW_DISPOSABLE_DB_TESTS=true`, run `npm run test:yield-history-integration --prefix api`. Fixtures and projections are rolled back. The tests cover replay, old-slot backfill, identity/commitment filtering, owner/recipient separation, transfer fees, event timestamps, missing history, failed-batch rollback, database source guards, non-finite price rejection, canonical LP ownership, and conflicting finalized account evidence. Unit tests also verify bounded retries preserve the exact finalized bank and reject unavailable timestamps.

`npm run test:prices-integration --prefix api` uses the same disposable-database opt-in. It verifies stable historical values after a reference change, late backfill, equal-timestamp/different-slot preservation, missing/stale/future observations, finalized conflicts, exact decimal arithmetic, immutable rows, source guards and replay compatibility for both market-state bases. The capture worker and native price route also require read-only devnet verification before deployment.

## Portfolio snapshots

Migration 033 adds immutable raw portfolio captures, account evidence, bounded replay, source-bound owner checkpoints and notifications. After applying the migration manifest and building the API, keep the native daemon and LP ownership worker running, then start the snapshot worker:

```sh
npm run start:native-portfolio-worker --prefix api -- --once
```

Omit `--once` to capture every minute, or set `DUSK_PORTFOLIO_INTERVAL_MS` (minimum 1000). `--replay-only` drains saved captures without RPC. `railway.portfolio-snapshots.toml` defines the service. It requires the same checked protocol artifacts, RPC and database configuration as other native workers. Services and webapp adapters still need deployment/wiring; this command does not publish or upgrade anything.

Capture requires completed native account and all LP-mint ownership scans. The market catalog is validated by decoding immutable raw account bytes, since the Rust JSON projection represents integer arrays differently from the SDK. Discovery may be at most `DUSK_PORTFOLIO_MAX_CATALOG_AGE_SLOTS` behind the observed tip (default 750; allowed 1–2500). Empty LP scans are included in the freshness check. A catalog that ages out during capture is rejected. Refresh discovery before retrying; never substitute zero for missing scan coverage. Stored contradictory finalized native or LP scans also halt discovery consumers.

The simulation reader includes up to 20 related read-only accounts and returns their post-simulation bytes with the updated market and preview. It checks the serialized transaction packet limit. Finalized reads use the finalized discovery and program deployment slots as their minimum, not the envelope's newer confirmed tip. Lagging-replica minimum-slot errors receive four bounded attempts without lowering that minimum. A program-local preview failure falls back to a fresh finalized account read while leaving valuation unavailable. Invalid response data, regressed slots or changed deployment identity fail the capture.

Raw captures commit before projection. Replay uses only the saved catalog, raw account/preview bytes and dated price policy. It does not consult current balances or prices. Every captured catalog account must appear exactly once, including null results for closed accounts. Prior owners are retained after transfers and closures so an observed empty snapshot can follow a nonempty one. Contradictory finalized account evidence remains stored and disables replay and reads. Different slots sharing one block timestamp remain separate capture IDs; late older captures are replayable and do not replace newer history.

The calculation preserves the program's single internal yLP denominator, collateral/debt asset bindings, indexed fixed and isolated debt, and hLP principal inventory minus indexed funding debt. hLP inventory uses curve reserves after removing unrealized lending interest. Its `hlp-principal-nav.v1` value is a current principal estimate, not an executable exit quote; underwater shares retain signed NAV evidence with zero limited-liability principal. Leverage margin and open notional are cost-basis fields and are not added again as assets. Unknown values make the total unavailable while retaining an explicitly separate known subtotal. Wallet balances and unclaimed yield are excluded from `netPositionValueUsd`.

`GET /api/dusk/v1/owners/:owner/portfolio-snapshots` accepts optional `since`, `until`, `limit` and `offset`. Each snapshot carries exact valuations, components with source slots/blockhashes/times, the full deployment identity, scan references, and coverage. The timestamp is the latest captured block time, and the complete slot range remains visible. Discovery and valuation are sampled at different banks; `discoveryAtomicWithValuation`, `completeAtValuationSlot`, `atomicAcrossMarkets` and `historyComplete` remain false. New accounts created after discovery may be absent until the next capture. An owner without recorded snapshots receives `available: false`, not an invented zero portfolio. These values never authorize transactions.

`npm run test:portfolio-integration --prefix api` uses the disposable database opt-in. Tests cover stable replay, older backfill, equal timestamps, LP authority changes, closed-account zeros, missing prices, malformed-batch rollback, immutable rows, source guards and finalized conflicts. `test:native-integration` additionally checks discovery against populated native scans and the confirmed-versus-finalized boundary. A read-only devnet capture produced three owner snapshots from 51 accounts across three markets at slots 497815394–497815425, with no replay backlog. The owner HTTP route passed envelope/provenance, invalid-address, future/reversed-time and missing-owner checks. No transactions were submitted. This establishes capture onward; historical coverage and webapp integration remain separate work.

The standalone portfolio `--once` command also captured 51 accounts for three owners at slots 497818252–497818276 after native/LP discovery was refreshed. `--replay-only` completed with no backlog. Discovery freshness is a required runtime dependency, not a reason to reuse outdated ownership silently.
