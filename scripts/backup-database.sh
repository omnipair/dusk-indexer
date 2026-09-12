#!/usr/bin/env bash
#
# Back up the indexer database, and prove the backup restores.
#
# A backup nobody has restored is a belief, not a backup. This takes a dump and
# then restores it into a scratch database and counts what came back, so a
# failure surfaces here rather than during the outage it was taken for.
#
#   scripts/backup-database.sh                 # dump, verify, keep
#   scripts/backup-database.sh --verify-only   # dump, verify, delete
#
# DATABASE_URL must point at the database to back up. The scratch database is
# created beside it and dropped afterwards; it is never the source.
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL must be set}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DUMP="${BACKUP_DIR}/dusk-indexer-${STAMP}.dump"
VERIFY_ONLY=0
[ "${1:-}" = "--verify-only" ] && VERIFY_ONLY=1

mkdir -p "${BACKUP_DIR}"

echo "dumping to ${DUMP}"
# Custom format, so a restore can be selective and parallel. Blobs included
# because the event payloads are stored as JSON columns, not large objects,
# and excluding them has bitten people who assumed otherwise.
pg_dump --format=custom --no-owner --no-privileges --file="${DUMP}" "${DATABASE_URL}"
echo "dump is $(du -h "${DUMP}" | cut -f1)"

# Restore into a scratch database named after this run, so a failed verify
# leaves evidence rather than a half-restored production database.
# Lowercased with tr rather than ${VAR,,}: that expansion needs bash 4, and
# macOS ships 3.2, so the script would only fail on the machine most likely to
# be running it by hand during an incident.
SCRATCH="dusk_restore_check_$(echo "${STAMP}" | tr '[:upper:]' '[:lower:]')"
ADMIN_URL="${DATABASE_URL%/*}/postgres"

cleanup() {
  psql "${ADMIN_URL}" -q -c "DROP DATABASE IF EXISTS ${SCRATCH};" >/dev/null 2>&1 || true
  [ "${VERIFY_ONLY}" = "1" ] && rm -f "${DUMP}"
  return 0
}
trap cleanup EXIT

echo "restoring into ${SCRATCH}"
psql "${ADMIN_URL}" -q -c "CREATE DATABASE ${SCRATCH};"
# A restore of a Timescale dump reports errors for extension objects it cannot
# recreate in a plain database. Those are expected; a missing table is not,
# which is what the counts below actually check.
pg_restore --no-owner --no-privileges --dbname="${DATABASE_URL%/*}/${SCRATCH}" "${DUMP}" \
  >/dev/null 2>&1 || echo "  (pg_restore reported errors; the counts below decide)"

echo "verifying"
FAILED=0
# The tables whose loss would actually cost something: the event history, the
# cursor that makes ingestion resumable, the identity the envelope is checked
# against, and the valuation inputs that cannot be recovered from chain.
for TABLE in   dusk_ingestion.event_stream   dusk_ingestion.ingestion_cursors   dusk_ingestion.protocol_identities   dusk_ingestion.token_metadata   dusk_ingestion.usd_price_anchors; do
  SOURCE=$(psql "${DATABASE_URL}" -tAc "SELECT count(*) FROM ${TABLE};" 2>/dev/null || echo missing)
  RESTORED=$(psql "${DATABASE_URL%/*}/${SCRATCH}" -tAc "SELECT count(*) FROM ${TABLE};" 2>/dev/null || echo missing)
  if [ "${SOURCE}" = "${RESTORED}" ] && [ "${SOURCE}" != "missing" ]; then
    echo "  ${TABLE}: ${RESTORED} rows"
  else
    echo "  ${TABLE}: source=${SOURCE} restored=${RESTORED}  MISMATCH"
    FAILED=1
  fi
done

if [ "${FAILED}" = "1" ]; then
  echo "restore did not reproduce the source; the backup is not trustworthy"
  exit 1
fi
echo "backup verified${VERIFY_ONLY:+ (discarded)}"
