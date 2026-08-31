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

# The v1 compatibility views. Re-runnable, and a no-op where the real
# Omnipair v1 tables exist.
echo "applying 020_dusk_v1_compatibility.sql"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f /app/migrations/020_dusk_v1_compatibility.sql

echo "applying 021_dusk_valuation_and_positions.sql"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f /app/migrations/021_dusk_valuation_and_positions.sql
echo "applying 022_dusk_retention.sql"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f /app/migrations/022_dusk_retention.sql

# USD price anchors. Assets whose dollar value is taken as given — a mock
# stablecoin on a test cluster, for instance — from which every other asset
# is priced by pool ratio. Format: "mint:price,mint:price". Without it the
# valuation views produce nothing, which is the honest result: no anchor
# means no basis for a dollar figure.
if [ -n "${DUSK_USD_ANCHORS:-}" ]; then
  echo "seeding USD price anchors"
  IFS=',' read -ra ANCHORS <<< "$DUSK_USD_ANCHORS"
  for anchor in "${ANCHORS[@]}"; do
    mint="${anchor%%:*}"
    price="${anchor##*:}"
    if [ -z "$mint" ] || [ -z "$price" ] || [ "$mint" = "$price" ]; then
      echo "skipping malformed anchor '$anchor' (expected mint:price)" >&2
      continue
    fi
    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c \
      "INSERT INTO dusk_ingestion.usd_price_anchors (mint, price_usd, note)
       VALUES ('$mint', $price, 'seeded from DUSK_USD_ANCHORS')
       ON CONFLICT (mint) DO UPDATE
         SET price_usd = EXCLUDED.price_usd, updated_at = now()" >/dev/null
  done
fi

exec dusk-indexer-daemon
