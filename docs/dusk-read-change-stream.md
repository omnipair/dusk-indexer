# Native read-change stream

`GET /api/dusk/v1/changes` opens an HTTP server-sent event stream. Each named
`dusk-change` event contains a successful `dusk-deployment.v2` envelope and:

```json
{
  "schemaVersion": "dusk-read-change.v1",
  "streamId": "11111111-1111-4111-8111-111111111111",
  "sequence": 1,
  "kind": "resync",
  "sourceSlot": 0
}
```

These are cache refresh hints. They contain no reserves, price, balance, swap
amounts or transaction authority. Consumers reload through their normal native
API/RPC boundaries and cache by the complete deployment identity. A notice slot
is a lower bound for the frame's envelope, not proof that every projection is
complete through that slot. Periodic query refresh remains the fallback for
projection lag and missed notifications.

The existing PostgreSQL listener accepts only notifications matching the active
cluster/program/IDL/revision and a safe integer slot in the pinned release
interval. It invalidates known read-cache prefixes and publishes a sanitized
change hint. Account scans and event inserts already notify this listener.
Migration 037 also notifies after a relative quote projection is inserted,
including when USD prices are unavailable. PostgreSQL delivers the notification
after its transaction commits.

The first frame is `resync`, sequence 1, with a new UUID. Subsequent frames have
consecutive sequence numbers. Initial/resume resync and heartbeat frames may
have slot 0; a change has a nonzero source slot. A heartbeat always has slot 0.
Change bursts coalesce to the highest slot within a 250 ms batch window. Heartbeats are scheduled every fifteen seconds. Every frame observes
the configured on-chain deployment and must retain the connection's full
identity. An upgrade, database-listener failure or observation failure closes
the connection. A reconnected client receives a resync; `Last-Event-ID` is not a
replay cursor and missed events are not replayed.

The API caps each process at 128 open streams, closes a backpressured response
instead of queueing frames, and bounds each listener-start/observation wait to
twenty seconds. Closing releases the subscription and timers. An observation
already shared with other API readers may finish in the background, but cannot
write to a closed stream. Initial failures return HTTP 503; capacity returns
429. Responses disable caching and proxy buffering. The existing request-rate
limiter also applies to connection attempts.

## Native gRPC-Web

`omnipair.stream.StreamService/StreamDuskChanges` is a separate native RPC on
our existing Rust/tonic gRPC server. It uses the same PostgreSQL LISTEN/NOTIFY →
bounded broadcast → generated browser client pattern as the Omnipair stream.
It listens to `dusk_events_updated` and `dusk_accounts_updated`, validates the
compiled protocol lock, and coalesces notifications to the highest source slot.
The legacy `StreamSwapsUpdates` contract is unchanged and cannot supply Dusk
prices: its reserve-ratio messages lack native deployment evidence.

Each protobuf `DuskChange.envelope_json` carries the exact native success frame
shown above. No financial values are accepted from a database notification.
The producer requests a fresh `/api/dusk/v1/deployment?minimumSourceSlot=N`
observation, validates both pinned programs (binary, IDLs, loader address, deploy
slot and upgrade authority), and retains the same durable identity throughout
a connection. Requests are bounded to ten seconds and 16 KiB. Concurrent
clients share observations for at most 250 ms without changing their evidence
timestamps. There are at most 128 native subscribers.

The native gRPC heartbeat is five seconds. A watch channel bounds queued work
to the latest notice; per-client frames have consecutive sequence numbers.
`PgListener::try_recv` makes reconnect gaps explicit: a listener failure or new
listener generation closes old client streams, and the next connection starts
with a new resync. Dropping a client releases its permit and pending work.

The companion app uses one native subscription, selected by
`NEXT_PUBLIC_DUSK_GRPC_URL` (and its network-specific variants). Without that
setting, it continues to use native SSE during rollout. Configured gRPC never
falls back to a legacy swap stream or a different deployment. Clients validate
the complete envelope, age, sequence and source-slot bounds before scheduling
reads. Reconnects use 1–30 second backoff and a 35-second silence watchdog.

VOB, Depth, entry orders, prices and trade/history queries refresh independently
on a notice with 250 ms burst coalescing. A slow query cannot hold up another
feed, and a notification received during a read causes one follow-up read
without cancelling the request. Book/order/history query polling is disabled
while connected. Heartbeats revalidate aging observations rather than extending
their freshness; disconnected streams use bounded fallback reads. Prices retain
their adaptive source-freshness deadline refresh as an additional guard. Other
native surfaces retain the existing ten-second refresh coalescing.

### Rollout

1. Deploy the API update that supports the fresh minimum-slot observation.
2. Deploy the existing `dusk-grpc` service with `DUSK_API_URL` pointing to that
   API. Its `DATABASE_URL` must be the same native deployment database, and
   `ALLOWED_ORIGINS` must include the app's existing production/preview origins.
3. Set `NEXT_PUBLIC_DUSK_GRPC_URL` to that service's public gRPC-Web URL and
   rebuild the frontend. The protobuf source is identical in both repositories.

This is push-triggered native revalidation, not a push of precomputed price,
book or trade payloads. VOB requires the program's accrued-state preview, so it
still performs a fresh read-only simulation after a notification. Writes keep
their existing independent SDK/RPC verification boundary.

Local acceptance on 2026-09-14 passed 134 API unit tests and 58 rollback database
tests after migration 037. The read-only devnet probe captured all four markets,
received a committed change at slot 498004879, completed three independently
verified market reads, and reconnected with a new resync. It submitted zero
transactions. Hosted proxy behavior, sustained load and deployment remain
separate release gates.
