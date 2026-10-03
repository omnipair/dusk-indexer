# Dusk Socket.IO streams

The Express API now serves native Dusk streams on `/socket.io` on its existing
HTTP port. The matching webapp uses one WebSocket transport connection per API
base URL for market prices/oracle EMA, candles, recent trades, virtual depth and
order overlays, wallet positions/PnL/orders, statistics, and read-change hints.
The existing capture, PostgreSQL coalescing, deployment identity, source slot,
revision, and expiry semantics are unchanged.

## Running and rollout

1. Configure `api/.env` using `api/.env.example`, including `DATABASE_URL` and the
   existing Dusk deployment/RPC settings required by the snapshot producers.
2. In `api`, run `npm ci`, `npm run build`, then `npm start` (or `npm run dev`).
3. Set `CORS_ORIGIN` to the webapp origin if restricting access. As with the REST
   API, an unset value allows all origins. Socket.IO also checks the browser's
   Origin during the WebSocket handshake, since CORS alone does not protect it.
4. Deploy this API before the webapp. The existing Dockerfile already uses the
   API package lock and includes the new dependency. Proxy `/socket.io/` to the
   same API process, allow WebSocket upgrades, and keep proxy idle timeouts above
   Socket.IO's default heartbeat window (60 seconds or more).
5. Point `NEXT_PUBLIC_DUSK_API_URL` at this API and rebuild/restart the webapp.
   There is no separate socket service or native gRPC environment variable.

The webapp does not fall back to SSE or native gRPC. The previous SSE endpoints
and gRPC service remain available for older clients during rollout. Chain
subscription/ingestion, REST bootstrap and history, wallet balance RPC/WebSocket
subscriptions, and transaction simulation/submission are unchanged.

Connections are WebSocket-only, so HTTP long-polling affinity is unnecessary.
Each API replica uses the existing local subscription hubs and PostgreSQL shared
snapshots; it reads its own updates rather than relying on process-local room
broadcasts reaching other replicas. No Redis Socket.IO adapter is required for
this design. A future room-broadcast design would need shared fanout.

## Wire contract

Client emits `dusk:subscribe` with a unique `id` (1–64 alphanumeric/hyphen
characters), a `channel`, and the corresponding `selection`:

| Channel | Selection | Frame event |
| --- | --- | --- |
| `changes` | omitted | `dusk-change` |
| `payload` | `{kind: "markets"}` | `dusk-payload` |
| `payload` | `{kind: "wallet", owner}` | `dusk-payload` |
| `payload` | `{kind: "statistics", range: "24h" \| "all"}` | `dusk-payload` |
| `payload` | `{kind: "trades", market}` | `dusk-payload` |
| `payload` | `{kind: "candles", market, side: "base" \| "quote", resolutionSeconds}` | `dusk-payload` |
| `virtual-book` | `{market, groupingBps}` | `dusk-virtual-book` |

Subscription acknowledgement is `{ok: true}` or `{ok: false, code}`. Numeric
resolutions and grouping sizes use the same allowlists as the existing endpoints.
Each `dusk:frame` packet is `{id, event, data}`, where `data` is the original JSON
envelope string with `streamId` and `sequence`. The client acknowledges receipt
immediately, then applies its existing deployment/freshness/continuity validation.
An acknowledgement proves delivery only, not validation or transaction execution.

`dusk:unsubscribe` takes the id string. `dusk:error` carries `{id, code}` and ends
that subscription. Disconnect releases all producers owned by that connection.
Errors contain fixed codes, never raw database/RPC errors or credentials.

Reconnect is owned by the webapp's existing exponential backoff controllers
(1–30 seconds), not by a second automatic replay mechanism. Each new subscription
starts at sequence 1 with a fresh stream UUID and a current full snapshot (or
`resync` for changes). An unexpired shared snapshot may be reused. There is no
replay log or exactly-once guarantee; the frontend still rejects stale, skipped,
wrong-selection, and incompatible-deployment frames.

## Bounds and checks

- 128 sockets, 512 socket subscriptions total, 16 subscriptions per socket.
- Existing snapshot hubs retain their 16-topic caps; identical selections share
  a producer, including with compatibility SSE clients.
- 60 subscribe/unsubscribe commands per socket per 10 seconds.
- 16 KiB incoming packets; 2 MiB maximum outgoing frame.
- One frame awaiting acknowledgement per subscription, plus at most 32 queued
  frames / 4 MiB. Five seconds without acknowledgement closes the subscription.
- Initial snapshot deadline: 25 seconds; change observations retain their
  20-second deadline. Financial freshness is governed by original expiry fields,
  not socket heartbeats.

Run `npm run test:unit` in `api`. The Socket.IO integration tests use actual local
WebSocket connections and injected snapshot producers; they need no database.
They cover all channels, selection validation/capacity, shared producers,
unsubscribe/reconnect, slow readers, origin checks, and deployment changes.
Database-backed production capture still needs a configured indexer deployment.
