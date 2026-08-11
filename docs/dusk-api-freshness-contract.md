# Dusk API and freshness contract

Status: foundation contract for `local-snapshot-0`. The existing legacy API does
not implement this contract and must not be presented as Dusk data.

## Identity is part of every response

Every request is evaluated against one exact identity:

```json
{
  "cluster": "surfpool-mainnet-fork",
  "program_id": "358bjJKXWxeAXAzteX1xTgyd9JNnjtzW8fnwCS8Da1mv",
  "idl_hash": "5e67579b6dbec5620a5578844cd56c44458a3167095d8db2e85fd76643d5473f",
  "protocol_revision": "local-snapshot-0"
}
```

Clients send expected identity values in configuration, not as a best-effort
hint. A mismatch returns `409 protocol_identity_mismatch`; the server never
mixes rows from two identities in one response or resumes an old cursor under a
new identity.

Response headers mirror the envelope:

- `X-Dusk-Cluster`
- `X-Dusk-Program-Id`
- `X-Dusk-Idl-Hash`
- `X-Dusk-Protocol-Revision`
- `X-Dusk-Commitment`
- `X-Dusk-Indexed-Through-Slot`
- `X-Dusk-Finalized-Through-Slot`

## Envelope

```json
{
  "meta": {
    "identity": {
      "cluster": "surfpool-mainnet-fork",
      "program_id": "358bjJKXWxeAXAzteX1xTgyd9JNnjtzW8fnwCS8Da1mv",
      "idl_hash": "5e67579b6dbec5620a5578844cd56c44458a3167095d8db2e85fd76643d5473f",
      "protocol_revision": "local-snapshot-0"
    },
    "commitment": "confirmed",
    "indexed_through_slot": 123,
    "finalized_through_slot": 120,
    "chain_tip_slot": 124,
    "lag_slots": 1,
    "observed_at": "2026-08-11T18:00:00Z",
    "freshness": "ready",
    "reconciliation": "matched",
    "backfill": "complete",
    "next_cursor": null
  },
  "data": []
}
```

Amounts remain decimal strings in token atoms. Public keys and signatures remain
base58 strings. Event payloads include `event_name`, `event_key`, `slot`,
`blockhash`, `commitment`, and `payload`; they are versioned by the envelope's
protocol identity rather than coerced into legacy pair fields.

## Read consistency

Requests may set `min_commitment`, `min_slot`, and `max_lag_slots`.

- `processed` is diagnostics-only and may disappear without notice.
- `confirmed` is the webapp default. A response can later be rolled back; clients
  use `event_key` for replacement/invalidation.
- `finalized` is required for irreversible accounting exports and durable keeper
  deduplication.
- `freshness=ready` means all requested bounds are met and reconciliation reports
  no known gap through `indexed_through_slot`.
- `freshness=catching_up` means an identity-scoped backfill is active.
- `freshness=reconciling` means canonical pointers or projections may change.
- `freshness=stale` means the caller's `max_lag_slots` bound was exceeded.

If a requested consistency bound is not met, return `503 freshness_unavailable`
with the same metadata and no decision-bearing `data`. Do not silently downgrade
commitment. Range endpoints return complete ranges or `503`; partial historical
ranges require an explicit `allow_partial=true` and enumerate every gap.

Opaque pagination cursors encode the protocol identity, commitment, canonical
event ordering tuple `(slot, transaction_signature, instruction_path,
event_ordinal)`, and reconciliation generation. A revision or generation mismatch
returns `409 cursor_invalidated`.

## Canonical and fork behavior

Normal endpoints expose only rows referenced by `canonical_events`. Debug/admin
endpoints may request observations and rollback journals explicitly. Ingestion
stores an alternate blockhash first, reconciles the winning block through RPC,
rolls back affected projections in one database transaction, then advances the
canonical pointer and cursor.

A finalized canonical row is never replaced. Conflicting finalized RPC evidence
sets health to unavailable and pages an operator; it is not auto-repaired.

Backfill and realtime ingestion share the same event key, decoder, observation
insert, canonicalization, and projection code. Replaying an already indexed range
must be idempotent. A range is complete only after a reconciliation run records
matching observation count and digest.

## Consumer rules

Webapp:

1. Request `confirmed` with an explicit `max_lag_slots` appropriate to the view.
2. Display degraded/reconciling state instead of treating cached data as current.
3. Treat transaction confirmation from the wallet/RPC as authoritative for a
   just-submitted action; the indexer may trail it.
4. Invalidate cached pages when identity or reconciliation generation changes.

Keepers:

1. Use the indexer only to discover and prioritize candidates.
2. Require the expected four-field protocol identity in every response.
3. Re-fetch all decision accounts from direct RPC immediately before execution.
4. Recompute eligibility and build/simulate against the pinned IDL before signing.
5. Re-check recent blockhash, account ownership, program executable address, and
   slippage/profit bounds before submission.

The indexer never authorizes a liquidation, TP/SL execution, auction bid, or
arbitrage transaction by itself.

## Initial endpoint surface

- `GET /v1/health`: identity, cursors, tip/lag, backfill, reconciliation.
- `GET /v1/events`: canonical event stream with commitment and cursor bounds.
- `GET /v1/markets/:market`: a Dusk projection with its as-of slot.
- `GET /v1/owners/:owner/positions`: yLP, hLP, lending, leverage, orders, locks,
  and referrals as separate revisioned projection families.
- `GET /v1/keeper/candidates`: discovery hints with freshness metadata; direct RPC
  revalidation remains mandatory.

Projection schemas are deliberately not defined by the legacy V2 database. They
must be derived from the vendored Dusk IDL and added with fixture-backed replay
tests.
