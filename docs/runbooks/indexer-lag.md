# Indexer falling behind

## Recognise it

`/status` returns 503 with `degraded: ["indexer-lag"]`. The number that matters
is `slotLag` — the distance between the chain's slot and the newest indexed
one. Anything over 15,000 slots trips the flag; a healthy deployment sits under
a few hundred.

Do not judge this by `latestEventAt`. A quiet market and a stalled indexer
produce the same old timestamp, and only the slot distance tells them apart.

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

`slotLag` is falling on consecutive `/status` calls and eventually sits in the
hundreds. Falling matters more than the absolute number — a catching-up indexer
is healthy, a stationary one is not.

## Do not

Do not clear the cursor to "start fresh". The cursor is what makes ingestion
resumable, and resetting it re-ingests from the beginning without fixing
whatever caused the lag.
