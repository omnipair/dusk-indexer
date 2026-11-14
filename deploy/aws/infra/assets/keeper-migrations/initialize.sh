#!/usr/bin/env bash
# Sourced inside the pinned TimescaleDB entrypoint on a new mainnet volume.
# This folder is an immutable, checksum-verified capture from the keeper repo.
(
  set -euo pipefail
  cd /keeper-migrations
  sha256sum --check --status SHA256SUMS
  script=$(mktemp)
  trap 'rm -f "$script"' EXIT
  cat > "$script" <<'SQL'
\set ON_ERROR_STOP on
SET ROLE keeper_writer;
SELECT pg_advisory_lock(482193016);
CREATE SCHEMA IF NOT EXISTS keeper_release AUTHORIZATION keeper_writer;
CREATE TABLE IF NOT EXISTS keeper_release.applied_migrations (
  name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
);
SQL
  while read -r checksum name; do
    [[ "$name" =~ ^[0-9]{4}_[a-z_]+\.sql$ && "$checksum" =~ ^[0-9a-f]{64}$ ]]
    {
    cat <<SQL
DO \$\$ BEGIN
  IF EXISTS (SELECT 1 FROM keeper_release.applied_migrations WHERE name='$name' AND sha256<>'$checksum') THEN
    RAISE EXCEPTION 'Keeper journal migration checksum changed';
  END IF;
END \$\$;
SELECT EXISTS (SELECT 1 FROM keeper_release.applied_migrations WHERE name='$name') AS applied \gset
\if :applied
\else
BEGIN;
SQL
    # The captured files each own one flat BEGIN/COMMIT transaction. Keep the
    # schema and its checksum ledger in the same atomic commit.
    sed '/^BEGIN;$/d; /^COMMIT;$/d' "$name"
    printf "INSERT INTO keeper_release.applied_migrations VALUES ('%s','%s',now());\nCOMMIT;\n\\endif\n" "$name" "$checksum"
    } >> "$script"
  done < SHA256SUMS
  printf 'SELECT pg_advisory_unlock(482193016);\n' >> "$script"
  psql -X --username postgres --dbname dusk_keeper_mainnet --file "$script"
)
