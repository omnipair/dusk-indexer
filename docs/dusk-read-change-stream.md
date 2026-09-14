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
Change bursts coalesce to the highest slot, with at most one frame every five
seconds. Heartbeats are scheduled every fifteen seconds. Every frame observes
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

The companion app uses one subscription on devnet. It validates the complete
envelope, frame age, sequence, schema and source slot; heartbeat payloads never
invalidate data. Refresh waves are at most once every ten seconds, scoped to
the full deployment query namespace. Slow in-flight reads finish before a
queued hint starts another read. Incompatible frames reset that namespace and
refresh deployment identity. Reconnect delay grows from one to thirty seconds;
a thirty-five-second silence watchdog reconnects an unresponsive stream.

This deliberately uses SSE on the native API rather than extending the
reference application's legacy gRPC swap payload. It preserves the reference
database-notification-to-cache-refresh architecture while keeping native
identity and final read validation explicit. Legacy swap messages calculate
reserve-ratio prices and lack the required Dusk envelope; they are disabled in
the companion app's devnet stream hooks. Remaining legacy UI consumers still
need native event adapters.

Local acceptance on 2026-09-14 passed 134 API unit tests and 58 rollback database
tests after migration 037. The read-only devnet probe captured all four markets,
received a committed change at slot 498004879, completed three independently
verified market reads, and reconnected with a new resync. It submitted zero
transactions. Hosted proxy behavior, sustained load and deployment remain
separate release gates.
