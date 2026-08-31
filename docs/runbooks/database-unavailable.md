# Database full or unavailable

## Recognise it

The API 503s on anything reading indexed data while `/status` still answers —
the status endpoint reads the chain for its slot figures, so it survives a
database it cannot query, and reports `ingestion-cursor` as degraded.

A full disk looks different from an outage: writes fail while reads succeed, so
the API keeps serving history that stops advancing, and the daemon logs write
errors rather than going quiet.

## What it breaks

All indexed reads: activity, history, positions, valuation. Live market state
is read from the chain and keeps working. Keepers are unaffected — they read
the chain directly, on purpose, so that a database problem cannot stop a
liquidation.

## Do

1. Check the volume in Railway. If it is full, that is the whole cause.
2. Free space by dropping the oldest event-stream chunks. On a Timescale
   hypertable:

   ```sql
   SELECT drop_chunks('dusk_ingestion.event_stream', older_than => INTERVAL '90 days');
   ```

   On a plain table, delete by `block_time` in batches rather than one
   statement, so the delete does not hold a lock for the length of the outage.
3. If the database is unreachable rather than full, restart it, then restart
   `dusk-indexer` so it reconnects and resumes from its cursor.

## Over when

`/status` has an empty `degraded` and `indexedEvents` climbs again.

## Do not

Do not drop the whole event stream to free space quickly. It is the only copy
of the deployment's history — the chain has the transactions, but recovering
them means re-ingesting from genesis. Restore from a backup instead; see
[the backup script](../../scripts/backup-database.sh).
