#!/usr/bin/env bash
# Apply the dusk_ingestion migrations idempotently, then run the daemon.
#
# 018 is transactional but not IF NOT EXISTS, so it only runs when the schema
# is absent; 019 is fully idempotent and reruns safely (it upgrades the
# event_stream table to a hypertable the first time Timescale is present).
set -euo pipefail

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is required" >&2
  exit 1
fi

# The database container may still be starting on a fresh deploy.
for attempt in $(seq 1 30); do
  if psql "$DATABASE_URL" -c "SELECT 1" >/dev/null 2>&1; then
    break
  fi
  echo "waiting for postgres (${attempt}/30)"
  sleep 2
done

schema_exists=$(psql "$DATABASE_URL" -tAc \
  "SELECT 1 FROM information_schema.schemata WHERE schema_name = 'dusk_ingestion'" || echo "")
if [ "$schema_exists" != "1" ]; then
  echo "applying 018_dusk_ingestion_foundation.sql"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f /app/migrations/018_dusk_ingestion_foundation.sql
fi

echo "applying 019_dusk_event_stream.sql"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f /app/migrations/019_dusk_event_stream.sql

exec dusk-indexer-daemon
