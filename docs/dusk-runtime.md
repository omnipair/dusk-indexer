# Dusk runtime entrypoints

Build the daemon from the repository root with `cargo build --locked -p dusk-indexer-daemon`, or use `Dockerfile.dusk-indexer`. The Railway configuration in `indexer/railway.toml` assumes the repository root is its build context. The daemon starts through `scripts/dusk-indexer-entrypoint.sh`; `Dockerfile.indexer` and the `omnipair-carbon-indexer` executable remain reference code and are not Dusk deployment entrypoints. Commit the tested workspace `Cargo.lock` with dependency changes; the deployment build requires it.

The Dusk HTTP API uses `Dockerfile.dusk-api` and `api/dist/index.js`. `DATABASE_URL`, `DUSK_CLUSTER` and `DUSK_RPC_URL` must describe the intended deployment. The API no longer supplies a default database/password. Live deployment must pass a direct RPC comparison against both program binaries in `protocol/protocol.lock.json`.

The active identity is `(cluster, program_id, canonical_idl_sha256, protocol_revision)`. `devnet-2026-09-13-9973dea` identifies the merged and upgraded devnet release. Raw source hashes remain independently checked. Old cursors and records cannot be reused under the new identity. Both the daemon and API require the pinned ProgramData addresses, deploy slots, authorities and binary payloads; matching bytecode alone cannot authorize another deployment under the same revision.

## Deployment intervals

The composite release starts at slot **497831835**, the slot after the later of the Dusk and delegate upgrades. At startup the daemon verifies both complete program payloads in one finalized bank after that boundary. While streaming, any loader transaction that upgrades, re-authorizes or closes either pinned program stops the daemon, and the next start re-verifies the full binaries against the lock.

Migration 034 records the immutable deployment pin and first slot, plus an upper bound advanced from direct finalized attestation. Migration 044 stops that bound from capping rows: the daemon streams confirmed transactions over a Helius Atlas WebSocket, so events land past the last attested finalized slot. Event persistence and cursor advancement still enforce the release's first slot. Database triggers reject mismatched program/IDL identities or slots before the release for registered revisions. Registration and observations share transaction locks, so a concurrent observation cannot evade the initial check. Contaminated existing current-revision history blocks registration; it is not relabelled or deleted. Historical identities remain intact.

An empty new-release history creates a cursor at the first deployment slot with no fabricated last signature. Each transaction raises the cursor's slot before its rows are written and sets the cursor's time after them. A 5-second heartbeat also sets the time, but only while the WebSocket delivers verified Clock updates, and it shares a lock with transaction writes, so every transaction that arrived before the cursor's time is written. The API serves the cursor as history coverage (`confirmed-stream.v1`) from the release's registration to the cursor's time. That is liveness, not proof of gap-free coverage: there is no backfill, and transactions confirmed while the stream is down stay missing unless replayed. The same cursor stamps the deployment envelope: database reads carry the stream's slot, and the API refuses every read (503) once the cursor is more than 15 s old.

Re-ingest one transaction, for example one the stream logged as dropped:

```sh
target/debug/dusk-indexer-daemon --replay <signature>
```

`npm run test:deployment-integration --prefix api` checks registration, immutable identity, boundary slots, contaminated history, cursor guards and concurrent writes in a disposable PostgreSQL database. All fixtures roll back. Native adapter tests also require fresh `--scan-accounts-once` and LP ownership captures under the current pin. CI provisions PostgreSQL, applies the checksummed manifest, captures read-only devnet discovery, runs the native tests and builds both service images. The container checks verify that every manifest migration and both pinned IDLs are actually present in the images.

The native CI job runs unit tests and rollback-only database fixtures. State
comes from streamed events, so no CI step reads devnet accounts.

## Migrations

`database/dusk-migrations.txt` is the only automatic migration manifest. It excludes the destructive reset SQL and the old retention policy. Both generic database scripts delegate to this manifest. The runner holds a PostgreSQL advisory lock, records checksums, stops on SQL errors and refuses altered applied migrations. It can adopt an existing foundation schema from the pre-ledger bootstrap.

Run migrations without starting the daemon:

```sh
DUSK_MIGRATE_ONLY=true bash scripts/dusk-indexer-entrypoint.sh
```

Migration 024 removes old event retention jobs. Until historical projections and archive coverage are complete, pruning the event stream would change the compatibility views' balances. A new retention policy must establish durable current state, completed historical allocation, and a replay/archive boundary first.

## Streamed state

Migration 046 derives current protocol state from canonical streamed events, as the v1 indexer keeps its positions. Nothing reads program accounts. Each view folds events in stream order (slot, then arrival):

- `streamed_markets` and `streamed_lp_mints`: one row per `MarketCreated`, with its yLP and two hLP mints.
- `streamed_leverage_positions`: the last lifecycle event decides open or closed; the last `LeveragePositionOpened`/`LeveragePositionUpdated` carries the post-state.
- `streamed_borrow_positions`: each lending event carries the position's post-state for what it changes: collateral from the latest `MarketCollateralDeposited`/`MarketCollateralWithdrawn`/`BorrowPositionLiquidated`, fixed debt shares from the latest `MarketDebtUpdated`/`BorrowPositionLiquidated`, the auction from `LiquidationAuctionStarted`/`LiquidationAuctionCancelled` and the events that report its side, and closure from the latest event (`closed`, or `DebtFreePositionClosed` for a borrow position).
- `streamed_lp_balances`: yLP and hLP balances per owner, from liquidity and hLP events (mints and burns) and `LpTransferred`, which the Token-2022 transfer hook on every LP mint emits for each transfer.
- `streamed_market_snapshots`: post-swap prices, growth indexes, reserves and yLP supply from canonical `SwapExecuted`, joined to `MarketCreated` for asset mints and decimals.

State covers markets created after ingestion of the release began; there is no backfill, so a gap in the stream is a gap in state. The account scan, the LP token scan, `/api/dusk/v1/accounts/:kind` and `/api/dusk/v1/lp-ownership` are removed.

## Live reads

Values that change without a transaction (accrued interest, claimable yield, capacity, NAV, health) are read by the API when a capture runs, never by a timer: discovery comes from the streamed state above or the delegate's order instructions, and each value from an account read or an unsigned program preview at or after the stream's slot. Owner and liquidation captures are shared across replicas through `live_snapshots` (a 2 s capture interval), carry `observedAt`, `expiresAt = observedAt + 15000` and the highest slot they read, and are served under an envelope that covers that slot. A preview the program rejects is reported as unavailable, never as zero.

- Markets payload (`/markets/state`, `/markets/state/:market`, `payloads?kind=markets`): `hlp` (`dusk-market-hlp.v1`) gives each vault's hLP supply, `lastNavNad`, funding EMA and slot after the `preview_market` update, with its hLP mint supply from the same bank (`sourceSlot` equals the market state's), and `capacity`: the `preview_hlp_deposit_capacity` status and funding limits. `hlp` is null when the market preview is rejected. `borrow` (`dusk-market-borrow.v1`) is keyed by debt asset: `preview_borrow_capacity` for one whole collateral token (cash and daily-limit headroom, health-limited debt, collateral factors). Each capacity carries its own `sourceSlot`, at or after the market bank, and is cached with the market snapshot.
- Wallet payload: `borrowValuations` values each open position in `streamed_borrow_positions` with `preview_borrow_position` (fixed debt, collateral value, health and liquidation terms per debt side, the position account's shares and auction state, the bank's Clock). `hlpPositions` gives, per vault the owner holds in `streamed_lp_balances` or escrows in open stop orders, the streamed wallet balance, the escrowed balance, the stop kinds and `preview_hlp_order_trigger`'s withdrawal price for their total. The wallet's hLP order list keeps executed and cancelled orders (status 1 and 2) until their yield is settled.
- Virtual book frame: `entryOrders` lists open leverage entry orders (latest create/cancel/execute instruction is the creation) with their terms read at or after the book's bank and the Clock of that read; closed and expired orders are dropped, and it is null when the read fails. At most 500 orders.
- `GET /api/dusk/v1/liquidations` (`dusk-liquidations.v1`): open borrow positions with debt, valued as in the wallet payload; `candidates` are those with a liquidatable side or a running auction, `unavailable` those whose preview was rejected.
- `GET /api/dusk/v1/owners/:owner/governance?market=` (`dusk-owner-governance.v1`): the yLP the owner has locked per proposal, folded from `ParameterProposalCreated` (a proposer's sponsorship), `ParameterProposalSupported` (the supporter's locked total) and `ParameterProposalSupportWithdrawn`; with `market`, whether its two yLP yield accounts exist and need growth.
- `GET /api/dusk/v1/owners/:owner/referral-partner` (`dusk-referral-partner.v1`): the partner's terms from `ReferralPartnerConfigured` and `ReferralRecipientUpdated`, and per market and asset its accrual amount from `ReferralInterestAccrued` and `ReferralInterestClaimed`. Whether each accrual account exists and each mint's transfer-fee schedule and epoch come from one account read, so `recipientCredit` is net of the fee in force now.
- `GET /api/dusk/v1/owners/:owner/yield` (`dusk-owner-yield.v1`): every LP the owner has held in `streamed_lp_balances`, including emptied holdings, and every hLP stop-order escrow not yet settled, valued at the amount Harvest would pay from one `preview_market` bank with its yield accounts, LP holding, asset mints and Clock; `unavailable` names groups whose market preview was rejected.

## Yield payment history

Migration 028 adds immutable history tables. The finalized claim projector, recorded-growth yield checkpoint worker, native price worker and portfolio capture worker are implemented locally. The legacy compatibility views must not be treated as native historical truth.

After the migration manifest has completed, build the API and run the claim worker:

```sh
npm run build --prefix api
npm run start:yield-claims-worker --prefix api -- --once
```

Omit `--once` to keep it running: it drains once, then again after every event the daemon writes, woken by the `dusk_event_ingested` notification (migration 045). A lost connection reconnects and drains, so a restart catches up. `railway.yield-claims.toml` defines the worker service. It requires `DATABASE_URL` and the same checked `protocol/` artifacts as ingestion. It reads already-attested finalized events and never signs or contacts a wallet. Apply migrations before starting it; it does not change the database schema itself.

Each bounded transaction selects unprojected `YieldClaimed` events through the full protocol identity and finalized canonical pointer. A PostgreSQL transaction lock serializes replicas. There is no monotonic slot cursor that could skip a later backfill at an older slot. Missing or contradictory event-time records and malformed values fail the batch without advancing it. Database guards bind every immutable projection to its exact observation, payload, blockhash and block time. Successful inserts notify native read consumers.

`GET /api/dusk/v1/owners/:owner/yield-claims` accepts optional `market`, `since`, `until`, `limit` and `offset`. It returns exact decimal-string payments, the earning owner, delegated caller, recipient, mint, and full finalized provenance. Gross swap-fee/interest yield and net recipient credit remain separate for transfer-fee tokens. The route uses the deployment envelope and fresh identity boundary.

Coverage reports indexed/projected/pending claim counts for the protocol identity. `projectionComplete` means all currently indexed finalized claims are projected; it does not prove historical ingestion coverage. `ingestionRangeComplete` and `accrualHistoryAvailable` remain false. An empty result must not be rendered as proof that the owner earned or claimed zero. Claimed cash flow is not event-time earned yield, and current LP balances or current token prices are never substituted for historical observations.

## Recorded yield growth

`SwapExecuted` publishes the post-swap price, EMA, reserves, yLP supply and growth indexes for both sides. `analytics/yield-rates` uses the latest canonical swap snapshot at or before each window boundary and prices each growth point from its committed snapshot. A snapshot remains valid until the next swap; there is no snapshot or program-price age cutoff. Its basis remains `committed-market-growth.v1` at `confirmed` commitment. The old yield-checkpoint worker, its account reads and `GET /api/dusk/v1/owners/:owner/yield-checkpoints` remain removed. Interest growth between swaps is reported at the next swap, so a window with no distinct swap snapshots has no measured rate.

## Dated price observations

Program prices come from canonical `SwapExecuted` snapshots at read time: the program's decimal-normalized, curve-aware spot quote per side, under the dated reference policy. Nothing simulates `preview_market` on a timer any more.

`protocol/devnet-price-references.json` carries the existing webapp's three explicit devnet display references, with a full protocol identity, effective date and source notes. They are configured demo valuations, not external market prices. Override the path with `DUSK_PRICE_REFERENCES_FILE` when using another reviewed policy. A program/IDL/revision change requires deliberately updating this policy's identity. A configured value prices that specific mint; when only its counterasset has a reference, the program's spot quote derives an estimated reference. Arithmetic uses integers and decimal strings, with derived prices rounded down to 36 decimal places. It never substitutes a reserve ratio for a concentrated curve's price.

`npm run start:prices-worker --prefix api` records provider quotes (Jupiter, with Birdeye as fallback) for every referenced mint in `MarketCreated`. It runs when events land, woken by `dusk_event_ingested`, and refreshes a mint at most every 30 s. Unlike the v1 volume enricher, a quote fetched after an event cannot price that same event; it becomes available to later events. `railway.prices.toml` defines the worker. `DUSK_PRICE_INTERVAL_MS` no longer exists.

`GET /api/dusk/v1/prices/:mint` accepts `market`, `at`, `maxAgeSeconds` (1–86400, default 3600), `limit` and `offset`. It returns program-derived prices from every swap snapshot quoting the mint within the window, newest first, with the observation's event key, payload hash, reference and spot quote as evidence (`market-observed.v1`). Missing prices return an empty list and `available: false`; an unknown price stays unknown. Saved preview captures from earlier releases remain readable only through archived quote history.

## Recorded market activity

Migration 035 binds immutable economic activity records to their exact finalized
canonical event and containing block timestamp. Apply the migration manifest,
build the API, and run:

```sh
npm run start:market-activity-worker --prefix api -- --once
```

Omit `--once` to keep it running: it drains once, then again after every event
the daemon writes, woken by the `dusk_event_ingested` notification (migration
045). `railway.market-activity.toml` defines the worker.
It reads saved events and writes projections; it does not contact RPC, hold a
signing key or submit transactions. Each transaction projects at most 500 events
under a protocol-scoped PostgreSQL lock. Late older-slot events remain eligible,
and repeated passes do not double count them.

`GET /api/dusk/v1/analytics/activity` accepts `since`, `until` and `market`.
It returns protocol-wide and
per-market observed volume, swap fees, retained fees, compounded fees and
explicitly reported interest payments under a freshly attested deployment
envelope. All amounts are decimal strings. Spot swaps and embedded leverage
swap receipts contribute input volume once. Margin-only leverage updates do not
contribute a swap. Fees use their declared input/output asset; retained and
compounded fees are components of swap fees, not additional fees. Claimed yield,
referral allocations and fee auctions do not count as newly earned fees.

Valuation prices each event from the latest swap snapshot for its market at
a strictly earlier slot and a non-future time
(`latest-observed-prior-slot.v1`). Quiet markets have no native snapshot age
cutoff. Valuation prefers the latest provider quote captured no later than the
event, without a provider age cutoff. A quote captured after an event cannot
price that event retroactively.
Same-slot snapshots are excluded because an event does not say where in its
slot the trade fell. Arithmetic rounds down to 36 decimal places.

Each metric distinguishes `observedUsd` from `valuedUsd`. Any unpriced nonzero
amount makes `observedUsd` null; `valuedUsd` is the explicitly partial known
subtotal. Zero amounts need no price. These values use configured/derived devnet
reference prices, not verified external USD market prices.

Coverage includes indexed/projected/pending counts, selected source slots and
a hash binding the selected events, valuations and query. `projectionComplete`
only means currently indexed finalized economic events have been projected.
`historyRangeComplete`, `totalInterestAccrualAvailable` and
`feeAllocationAvailable` remain false: there is no complete historical range
proof, not every interest accrual is an emitted payment, and these receipts do
not reconstruct the full LP/protocol fee allocation. Consumers must not show
observed subtotals as complete all-time/24-hour totals or infer APR from them.

## Finalized market event history

`GET /api/dusk/v1/history/events` accepts `market`, `since`, `until`, `limit`
(1–500, default 100) and `cursor`. The optional market must be a canonical
Solana public key. `until` defaults to the request time and cannot be in the
future. Follow the returned `nextCursor` with the same market and normalized
time window; it is bound to the full protocol and deployment identity.

The route reads finalized canonical observations in descending slot/event-key
order. It preserves separate CPI events within one transaction, exact decimal
amounts, instruction paths, event ordinals and containing-block provenance.
It covers swaps, liquidity additions/removals, market collateral/debt changes,
borrow liquidations and leverage open/update/close/liquidation events. Other
program events are outside this feed's declared coverage.

Each page uses a repeatable-read transaction and an observation-ID watermark.
Later inserted observations do not shift an existing pagination chain. The
watermark is not a sealed database snapshot across concurrent commits or
finalization. Exhausting a page chain does not prove a complete historical
range: `historyRangeComplete` remains false. The cursor is a read-selection
token, not an authorization credential. Fresh queries can include late backfill.

The source event must have one matching immutable event-time record. A missing
or contradictory selected record fails the read; contradictory finalized
observations halt the active identity's history. Both sides of the database
read are bracketed by direct RPC deployment attestation, and the returned
envelope must cover the highest selected event slot. No legacy activity view
or current-price valuation supplies this route.

After building the API, run the rollback-only history integration tests with
the disposable database opt-in described below:

```sh
node --test api/dist/tests/duskEventHistory.integration.js
```

The three cases cover same-slot CPI pagination, exact large amounts, confirmed
and other-revision exclusion, late backfill, cursor scope, and missing or
contradictory timestamps. A local read-only devnet check at slot `497953403`
verified the deployed identity and rejected a malformed cursor with HTTP 400.
The selected market had no captured events, so populated event values and
pagination are established by fixtures, not this live check. No transaction
was signed or submitted. This additive endpoint needs no new migration beyond
the existing checked manifest; deployment and full historical coverage remain
separate release work.

## Verification

Rust unit tests:

```sh
cargo test -p dusk-indexer-foundation -p dusk-indexer-daemon
```

`npm run test:market-activity-integration --prefix api` requires the disposable
database opt-in below. Its rollback-only fixtures exercise finalized identity
filtering, late backfill, all economic event types, missing/contradictory event
timestamps, database immutability, partial valuations, prior-slot pricing,
deployment separation, saved policy changes and same-slot events spanning
multiple 500-row pages. The API unit suite covers exact quantities, fee asset
selection, transfer taxes, hLP interest side and rejected price boundaries.

After applying the manifest to a disposable PostgreSQL database, run `database/tests/native-account-projections.sql` with `psql -v ON_ERROR_STOP=1`. It checks idempotence, account closure, out-of-order replay, and finalized conflict rejection. The API's existing checks run through `npm run test:unit --prefix api`.

With `DATABASE_URL` pointing to a disposable database and `DUSK_ALLOW_DISPOSABLE_DB_TESTS=true`, run `npm run test:yield-history-integration --prefix api`. Fixtures and projections are rolled back. The tests cover replay, old-slot backfill, identity/commitment filtering, owner/recipient separation, transfer fees, event timestamps, missing history, failed-batch rollback, database source guards, non-finite price rejection, canonical LP ownership, and conflicting finalized account evidence. Unit tests also verify bounded retries preserve the exact finalized bank and reject unavailable timestamps.

`npm run test:prices-integration --prefix api` uses the same disposable-database opt-in. It verifies stable historical values after a reference change, late backfill, equal-timestamp/different-slot preservation, missing/stale/future observations, finalized conflicts, exact decimal arithmetic, immutable rows, source guards and replay compatibility for both market-state bases. The capture worker and native price route also require read-only devnet verification before deployment.

## Portfolio snapshots

Migration 033 adds immutable raw portfolio captures, account evidence, bounded replay, source-bound owner checkpoints and notifications. After applying the migration manifest and building the API, keep the streaming daemon running, then start the snapshot worker:

```sh
npm run start:native-portfolio-worker --prefix api -- --once
```

Omit `--once` to capture every minute, or set `DUSK_PORTFOLIO_INTERVAL_MS` (minimum 1000). `--replay-only` drains saved captures without RPC. `railway.portfolio-snapshots.toml` defines the service. It requires the same checked protocol artifacts, RPC and database configuration as other native workers. Services and webapp adapters still need deployment/wiring; this command does not publish or upgrade anything.

Discovery comes from the streamed-state views: markets, open borrow and leverage positions, and every owner with a positive yLP or hLP balance, valued through the owner's canonical Token-2022 account, which is the one yield accrues to. The catalog carries the stream's slot and time (`streamed-events.v1`). Capture requires the stream time within `DUSK_PORTFOLIO_MAX_CATALOG_AGE_SECONDS` (default 60; allowed 1–600) of the capture; the heartbeat keeps it current on a quiet market, so a stale time means the stream is down. Valuation banks start at the stream's slot, so every discovered position exists at its bank. A catalog that ages out during capture is rejected.

The simulation reader includes up to 20 related read-only accounts and returns their post-simulation bytes with the updated market and preview. It checks the serialized transaction packet limit. Finalized reads use the stream's slot and the program deployment slots as their minimum. Lagging-replica minimum-slot errors receive four bounded attempts without lowering that minimum. A program-local preview failure falls back to a fresh finalized account read while leaving valuation unavailable. Invalid response data, regressed slots or changed deployment identity fail the capture.

Raw captures commit before projection. Replay uses only the saved catalog, raw account/preview bytes and dated price policy. It does not consult current balances or prices. Every captured catalog account must appear exactly once, including null results for closed accounts. Prior owners are retained after transfers and closures so an observed empty snapshot can follow a nonempty one. Contradictory finalized account evidence remains stored and disables replay and reads. Different slots sharing one block timestamp remain separate capture IDs; late older captures are replayable and do not replace newer history.

The calculation preserves the program's single internal yLP denominator, collateral/debt asset bindings, indexed fixed and isolated debt, and hLP principal inventory minus indexed funding debt. hLP inventory uses curve reserves after removing unrealized lending interest. Its `hlp-principal-nav.v1` value is a current principal estimate, not an executable exit quote; underwater shares retain signed NAV evidence with zero limited-liability principal. Leverage margin and open notional are cost-basis fields and are not added again as assets. Unknown values make the total unavailable while retaining an explicitly separate known subtotal. Wallet balances and unclaimed yield are excluded from `netPositionValueUsd`.

`GET /api/dusk/v1/owners/:owner/portfolio-snapshots` accepts optional `since`, `until`, `limit` and `offset`. Each snapshot carries exact valuations, components with source slots/blockhashes/times, the full deployment identity, scan references, and coverage. The timestamp is the latest captured block time, and the complete slot range remains visible. Discovery and valuation are sampled at different banks; `discoveryAtomicWithValuation`, `completeAtValuationSlot`, `atomicAcrossMarkets` and `historyComplete` remain false. New accounts created after discovery may be absent until the next capture. An owner without recorded snapshots receives `available: false`, not an invented zero portfolio. These values never authorize transactions.

`npm run test:portfolio-integration --prefix api` uses the disposable database opt-in. Tests cover stable replay, older backfill, equal timestamps, LP authority changes, closed-account zeros, missing prices, malformed-batch rollback, immutable rows, source guards and finalized conflicts. `test:native-integration` additionally checks discovery against populated native scans and the confirmed-versus-finalized boundary. A read-only devnet capture produced three owner snapshots from 51 accounts across three markets at slots 497815394–497815425, with no replay backlog. The owner HTTP route passed envelope/provenance, invalid-address, future/reversed-time and missing-owner checks. No transactions were submitted. This establishes capture onward; historical coverage and webapp integration remain separate work.

The standalone portfolio `--once` command also captured 51 accounts for three owners at slots 497818252–497818276 after native/LP discovery was refreshed. `--replay-only` completed with no backlog. Discovery freshness is a required runtime dependency, not a reason to reuse outdated ownership silently.

## Archived chart observations across the September 18 upgrade

The chart history route accepts `archivedRevision=devnet-2026-09-13-9973dea`
only while the active pin is `devnet-2026-09-18-1fa72d3`. This is a separate,
explicit historical display scope. The outer `dusk-deployment.v2` envelope
still verifies the live deployment before/after the query. The nested archive
contains its original deployment envelope and original protocol tuple. Archived
IDL files and the checked release lock are packaged under `protocol/archive`.
Saved Borsh bytes, hashes, market bindings and quote witnesses are verified using
that release's decoder; the SQL selection excludes slots at/after its replacement.
No observations are copied, rewritten or labelled as the active release. The
ordinary history route, live prices, ingestion cursors and all write boundaries
continue to reject a different protocol identity. Unknown archive/release pairs
are rejected. Frontends may combine validated segments for chart display only.
