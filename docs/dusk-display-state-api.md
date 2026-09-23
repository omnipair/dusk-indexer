# Wallet display-state API

These endpoints supply the account discovery and existing-position leverage
valuation consumed by [dusk-webapp #39](https://github.com/omnipair/dusk-webapp/pull/39).
They extend the confirmed live-snapshot service; finalized account discovery and
history routes remain available for their existing consumers.

## Routes and contracts

Both routes are under `/api/dusk/v1`, return `Cache-Control: no-store`, and use the
standard `{ success: true, deployment, data }` envelope. Public keys must be
canonical base58. Invalid route selections return 400. A missing or expired
shared snapshot returns 503; failed captures return an error, never fabricated
zero positions or a spot-price approximation.

| Route | Data |
| --- | --- |
| `GET /owners/:owner/accounts/:kind` | Complete account snapshot for `borrow`, `leverage`, `yield`, or `referral-accrual` |
| `GET /owners/:owner/leverage-valuations/:address` | Exact simulated full-close receipt for one leverage position belonging to the owner |

Every payload includes `schemaVersion`, `sourceSlot`, `observedAt` and `expiresAt`.
Timestamps are milliseconds since epoch; expiry is exactly 15 seconds after
capture begins. Delivery and cache hits never renew freshness. The response
deployment is freshly verified at or above the capture bank, and must match the
identity used to acquire and store the snapshot.

Account snapshots use schema `dusk-owner-accounts.v1` and include `owner`, `kind`,
`complete: true` and `accounts: [{ address, data }]`. `data` is base64 pinned-SDK
account bytes, preserving integers and account variants losslessly. A single
confirmed bank and owner/discriminator filters produce the complete list. Each
row is decoded and checked for program and wallet ownership before persistence.
An empty list is valid. More than 500 accounts, duplicate addresses or invalid
account bytes reject the whole capture; there is no silent truncation or paging
across banks.

Valuations use schema `dusk-leverage-valuation.v1`. `netOutputRaw`,
`grossCloseoutRaw`, nullable `triggerCloseoutPriceNad`, and all raw amounts in
`position` are decimal strings. Token mints, precisions and the full position
selection accompany them so a consumer can reject a quote after a position
mutation. `sourceSlot` is the simulation bank; `verificationSlot` is the bank of
the subsequent unchanged-position check. The envelope covers both. A curve
shape that does not support the existing trigger-price equivalence returns a
null trigger price while preserving the exact close receipt.

The backend builds an unsigned full-close transaction into a fresh token
recipient, simulates it with signature verification disabled, and checks the
native close event and returned token account. It supports SPL Token,
Token-2022 and wrapped native-token receipts. The position is read again after
simulation; concurrent changes invalidate the capture. This endpoint never
signs or submits a transaction and is not a submission quote.

## Persistence and rollout

Captures use the existing PostgreSQL `dusk_ingestion.live_snapshots` table and
cross-process advisory lock. Keys include the deployment identity, wallet and
account kind or position. Captures are coalesced across replicas with a two-second
cooldown, including failed attempts, and a 14-second capture deadline. Stored
payloads are ephemeral confirmed observations, not canonical historical events
or ingestion cursors. They do not advance finalized history.

The existing migration `043_dusk_live_snapshots.sql` must already be applied.
There is no new migration or worker. Runtime configuration uses the pinned Dusk
deployment and existing RPC settings. `DUSK_PREVIEW_PAYER` may designate a funded
public key for unsigned simulation; otherwise the deployment upgrade authority
is used, as in the existing virtual-book service. No private key is required.

Deploy this API before deploying webapp #39. Verify both routes against a known
devnet wallet/position before switching the webapp. The webapp intentionally has
no browser-RPC fallback for these reads, so deploying it first makes those
surfaces unavailable until the API is present.

## Validation evidence (2026-09-23)

- API TypeScript build and all 186 API unit tests passed. New coverage includes
  all account kinds, completeness, malformed scope, stale banks, unsigned
  simulation, token-program variants, invalid receipts and concurrent mutation.
- Three PostgreSQL integration tests passed against a dedicated disposable
  database: shared-snapshot coalescing/failure cooldown and display persistence
  without extending observation age. Run the display test together with
  `duskSharedSnapshot.integration.js` after building, with `DATABASE_URL` pointing
  to a disposable database and `DUSK_ALLOW_DISPOSABLE_DB_TESTS=true`.
- A local API using the configured devnet RPC returned six leverage positions
  and net close output `17606088` at simulation slot `502849270`. The webapp's
  actual account and valuation adapters consumed both HTTP responses with two
  HTTP requests and zero browser RPC calls. No transaction was signed or sent.
- Webapp validation: 1,438 unit tests, TypeScript and full lint passed. Dedicated
  wallet sign/send gates were not executed; transaction submission is unchanged.

## Wallet-wide stream

The wallet/statistics stream extension is documented in
[dusk-wallet-statistics-streams.md](dusk-wallet-statistics-streams.md). It batches
existing-position valuations and orders for atomic frontend updates while
retaining these per-position routes for older clients.
