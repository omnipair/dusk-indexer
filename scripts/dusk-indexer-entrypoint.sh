#!/usr/bin/env bash
# Explicit Dusk migrations only. Maintenance/reset SQL is never discovered.
set -euo pipefail
: "${DATABASE_URL:?DATABASE_URL is required}"
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
if [[ -d /app/migrations ]]; then
  migration_dir=/app/migrations
  manifest=/app/dusk-migrations.txt
else
  migration_dir="$script_dir/../database/migrations"
  manifest="$script_dir/../database/dusk-migrations.txt"
fi
ready=false
for attempt in $(seq 1 30); do
  if psql "$DATABASE_URL" -XAtqc 'SELECT 1' >/dev/null 2>&1; then ready=true; break; fi
  echo "waiting for postgres (${attempt}/30)"
  sleep 2
done
if [[ "$ready" != true ]]; then echo 'Postgres did not become ready' >&2; exit 1; fi
migration_script=$(mktemp)
trap 'rm -f "$migration_script"' EXIT
cat > "$migration_script" <<'SQL'
\set ON_ERROR_STOP on
SELECT pg_advisory_lock(482193015);
CREATE SCHEMA IF NOT EXISTS dusk_ingestion;
CREATE TABLE IF NOT EXISTS dusk_ingestion.applied_migrations (
  name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
);
SQL
while IFS= read -r name; do
  [[ -z "$name" || "$name" == \#* ]] && continue
  if [[ ! "$name" =~ ^[0-9]{3}_[a-zA-Z0-9_]+\.sql$ || ! -f "$migration_dir/$name" ]]; then
    echo 'Invalid migration manifest entry' >&2; exit 1
  fi
  if command -v sha256sum >/dev/null; then
    checksum=$(sha256sum "$migration_dir/$name" | cut -d ' ' -f 1)
  else
    checksum=$(shasum -a 256 "$migration_dir/$name" | cut -d ' ' -f 1)
  fi
  cat >> "$migration_script" <<SQL
DO \$\$ BEGIN
  IF EXISTS (SELECT 1 FROM dusk_ingestion.applied_migrations WHERE name='$name' AND sha256<>'$checksum') THEN
    RAISE EXCEPTION 'Applied migration checksum differs: $name';
  END IF;
END \$\$;
SELECT EXISTS (SELECT 1 FROM dusk_ingestion.applied_migrations WHERE name='$name') AS migration_applied \gset
\if :migration_applied
\else
SQL
  if [[ "$name" == 018_dusk_ingestion_foundation.sql ]]; then
    # Adopt the pre-ledger bootstrap only when the foundation table exists.
    cat >> "$migration_script" <<'SQL'
SELECT to_regclass('dusk_ingestion.protocol_identities') IS NOT NULL AS foundation_exists \gset
\if :foundation_exists
\else
SQL
  fi
  printf '\\i %s\n' "$migration_dir/$name" >> "$migration_script"
  if [[ "$name" == 018_dusk_ingestion_foundation.sql ]]; then printf '\\endif\n' >> "$migration_script"; fi
  printf "INSERT INTO dusk_ingestion.applied_migrations(name,sha256) VALUES ('%s','%s');\n" "$name" "$checksum" >> "$migration_script"
  printf '%s\n' '\endif' >> "$migration_script"
done < "$manifest"
printf 'SELECT pg_advisory_unlock(482193015);\n' >> "$migration_script"
psql "$DATABASE_URL" -X -f "$migration_script"

if [[ -n "${DUSK_USD_ANCHORS:-}" ]]; then
  IFS=',' read -ra anchors <<< "$DUSK_USD_ANCHORS"
  for anchor in "${anchors[@]}"; do
    mint="${anchor%%:*}"; price="${anchor#*:}"
    if [[ ! "$mint" =~ ^[1-9A-HJ-NP-Za-km-z]{32,44}$ || ! "$price" =~ ^[0-9]+([.][0-9]+)?$ ]]; then
      echo 'Invalid DUSK_USD_ANCHORS entry; expected base58-mint:nonnegative-price' >&2; exit 1
    fi
    psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -v mint="$mint" -v price="$price" <<'SQL'
INSERT INTO dusk_ingestion.usd_price_anchors (mint,price_usd,note)
VALUES (:'mint',:'price'::numeric,'seeded from DUSK_USD_ANCHORS')
ON CONFLICT (mint) DO UPDATE SET price_usd=EXCLUDED.price_usd,updated_at=now();
SQL
  done
fi
if [[ "${DUSK_MIGRATE_ONLY:-false}" == true ]]; then exit 0; fi
exec dusk-indexer-daemon
