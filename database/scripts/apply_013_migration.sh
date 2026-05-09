#!/bin/bash
# ============================================================================
# Apply Migration 013: Add pool_updates NOTIFY trigger on pools
# ============================================================================
# Description: This script applies the 013_add_pools_notify_trigger.sql
#              migration which creates the notify_pool_updated() function and
#              an AFTER INSERT OR UPDATE trigger on the `pools` table that
#              emits payloads on the `pool_updates` LISTEN channel.
#
#              The API process (api/src/services/poolInvalidationService.ts)
#              listens on this channel and invalidates the in-memory
#              `pools:enriched:*` cache populated by
#              PoolController.fetchAllPools, so that newly-created or
#              re-emitted pools become visible without waiting for the 60s
#              TTL to expire.
#
# Usage:
#   # Option 1: Using DATABASE_URL environment variable
#   DATABASE_URL="postgresql://user:password@host:port/dbname" ./apply_013_migration.sh
#
#   # Option 2: Pass DATABASE_URL as argument
#   ./apply_013_migration.sh "postgresql://user:password@host:port/dbname"
#
#   # Option 3: Use default user/database (legacy mode)
#   ./apply_013_migration.sh
#
# Prerequisites:
#   - PostgreSQL client installed
#   - Database connection configured (via DATABASE_URL or default settings)
#   - Migrations 001 through 012 must already be applied
# ============================================================================

set -e  # Exit on error

MIGRATION_FILE="../migrations/013_add_pools_notify_trigger.sql"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIGRATION_PATH="$SCRIPT_DIR/$MIGRATION_FILE"

if [ -n "$1" ]; then
    DATABASE_URL="$1"
elif [ -z "$DATABASE_URL" ]; then
    DB_USER="omnipair_user"
    DB_NAME="omnipair_indexer"
fi

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "============================================================================"
echo "Applying Migration 013: Add pool_updates NOTIFY trigger on pools"
echo "============================================================================"
echo ""
if [ -n "$DATABASE_URL" ]; then
    echo "Database: Using DATABASE_URL"
else
    echo "Database: $DB_NAME"
    echo "User: $DB_USER"
fi
echo "Migration: $MIGRATION_FILE"
echo ""
echo "NOTE: This creates a trigger that fires on every INSERT/UPDATE on pools."
echo "      The trigger is lightweight (single pg_notify call) and runs in the"
echo "      same transaction as the writing statement."
echo ""

if [ ! -f "$MIGRATION_PATH" ]; then
    echo -e "${RED}Error: Migration file not found at $MIGRATION_PATH${NC}"
    exit 1
fi

read -p "Do you want to apply this migration? (y/n) " -n 1 -r
echo ""

if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo -e "${YELLOW}Migration cancelled.${NC}"
    exit 0
fi

print_summary() {
    echo ""
    echo "Changes:"
    echo "  - Created function notify_pool_updated()"
    echo "  - Created trigger pools_notify ON pools (AFTER INSERT OR UPDATE)"
    echo "  - Emits JSON payloads on the 'pool_updates' LISTEN channel"
    echo ""
    echo "Consumed by: api/src/services/poolInvalidationService.ts"
    echo "             (invalidates pools:enriched:* cache entries)"
    echo ""
    echo "Verify with:"
    echo "  psql ... -c \"LISTEN pool_updates;\" &"
    echo "  psql ... -c \"UPDATE pools SET swap_fee_bps = swap_fee_bps WHERE id = (SELECT id FROM pools LIMIT 1);\""
}

echo "Applying migration..."
if [ -n "$DATABASE_URL" ]; then
    if psql "$DATABASE_URL" -f "$MIGRATION_PATH"; then
        echo ""
        echo -e "${GREEN}✓ Migration 013 applied successfully!${NC}"
        print_summary
    else
        echo ""
        echo -e "${RED}✗ Migration failed. Please check the error messages above.${NC}"
        exit 1
    fi
else
    if psql -U $DB_USER -d $DB_NAME -f "$MIGRATION_PATH"; then
        echo ""
        echo -e "${GREEN}✓ Migration 013 applied successfully!${NC}"
        print_summary
    else
        echo ""
        echo -e "${RED}✗ Migration failed. Please check the error messages above.${NC}"
        exit 1
    fi
fi

echo ""
echo "============================================================================"
