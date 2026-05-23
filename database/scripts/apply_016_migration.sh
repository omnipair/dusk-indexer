#!/bin/bash

# Apply Migration 016: Add explicit pool category assignments

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIGRATION_FILE="$SCRIPT_DIR/../migrations/016_add_pool_category_assignments.sql"

if [ ! -f "$MIGRATION_FILE" ]; then
  echo "Migration file not found: $MIGRATION_FILE"
  exit 1
fi

if [ -f "$SCRIPT_DIR/../.env" ]; then
  set -a
  source "$SCRIPT_DIR/../.env"
  set +a
fi

if [ -z "$DATABASE_URL" ]; then
  echo "DATABASE_URL is required"
  exit 1
fi

echo "Applying Migration 016: explicit pool category assignments"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f "$MIGRATION_FILE"
echo "Migration 016 applied successfully"
