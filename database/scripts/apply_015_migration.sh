#!/bin/bash

# Apply Migration 015: Add token category tables and cache invalidation trigger

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIGRATION_FILE="$SCRIPT_DIR/../migrations/015_add_token_categories.sql"

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

echo "Applying Migration 015: token categories and assignment invalidation"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f "$MIGRATION_FILE"
echo "Migration 015 applied successfully"
