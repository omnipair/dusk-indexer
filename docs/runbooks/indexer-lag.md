# Indexer falling behind

## Recognise it

`/status` returns 503 with `degraded: ["ingestion-stalled"]`. The number that
matters is `cursorAgeSeconds` — how long since the daemon last reported in.
The daemon touches its cursor on every poll whether or not it found anything,
so an age past five minutes means it has stopped polling.

**Do not judge this by `slotLag`, and do not judge it by `latestEventAt`.**
Both measure how recently somebody *traded*, not whether ingestion is working.
On a quiet devnet the lag grows without bound while the daemon is perfectly
healthy — which is exactly what it looked like the first time this endpoint
was written, because it flagged on lag.

## What it breaks

Anything served from the database: activity feeds, market history, portfolio
values, volume and fee figures. Live market state is read from the chain and
stays correct, so the app looks *inconsistent* rather than broken — current
prices beside stale history.

## Do

1. Check the daemon is alive at all. In Railway, `dusk-indexer` logs a line per
   ingested batch. Silence means the process is wedged rather than slow.
2. Check whether it is the RPC rather than the indexer — see
   [RPC provider outage](rpc-provider-outage.md). A rate-limited daemon falls
   behind without erroring.
3. If the daemon is alive and the RPC is healthy, restart `dusk-indexer`. It
   resumes from its stored cursor, so a restart costs only the batch in flight.
4. If lag keeps growing after a restart, the daemon is not keeping up with the
   chain rather than stuck. Reduce `DUSK_POLL_INTERVAL_MS` only if the RPC has
   headroom; otherwise this needs a wider ingestion window, which is a change
   rather than an incident action.

## Over when

`cursorAgeSeconds` is back under the threshold and staying there. If the market
is busy, `slotLag` should also be falling on consecutive calls — falling
matters more than the absolute number, since a catching-up indexer is healthy
and a stationary one is not. If the market is quiet, expect the lag to keep
growing and ignore it.

## Do not

Do not clear the cursor to "start fresh". The cursor is what makes ingestion
resumable, and resetting it re-ingests from the beginning without fixing
whatever caused the lag.
