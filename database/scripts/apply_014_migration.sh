#!/bin/bash
# ============================================================================
# Apply Migration 014: Add categories column to pools
# ============================================================================
# Description: This script applies the 014_add_pools_categories.sql migration
#              which adds a `categories` TEXT column to the `pools` table.
#              The column stores a comma-separated list of category tags
#              (e.g. "defi,stable") and is exposed as an array of strings
#              by the /pools API endpoint.
#
# Usage:
#   # Option 1: Using DATABASE_URL environment variable
#   DATABASE_URL="postgresql://user:password@host:port/dbname" ./apply_014_migration.sh
#
#   # Option 2: Pass DATABASE_URL as argument
#   ./apply_014_migration.sh "postgresql://user:password@host:port/dbname"
#
#   # Option 3: Use default user/database (legacy mode)
#   ./apply_014_migration.sh
#
# Prerequisites:
#   - PostgreSQL client installed
#   - Database connection configured (via DATABASE_URL or default settings)
#   - Migrations 001 through 013 must already be applied
# ============================================================================

set -e  # Exit on error

MIGRATION_FILE="../migrations/014_add_pools_categories.sql"
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
echo "Applying Migration 014: Add categories column to pools"
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
echo "NOTE: This adds a nullable TEXT column to pools. Existing rows get NULL,"
echo "      which the API treats as an empty categories array."
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
    echo "  - Added pools.categories TEXT (nullable)"
    echo ""
    echo "Consumed by: api/src/controllers/poolController.ts"
    echo "             (PoolController.fetchAllPools exposes a 'categories' array)"
    echo ""
    echo "Set categories with:"
    echo "  UPDATE pools SET categories = 'defi,stable' WHERE pair_address = '...';"
}

echo "Applying migration..."
if [ -n "$DATABASE_URL" ]; then
    if psql "$DATABASE_URL" -f "$MIGRATION_PATH"; then
        echo ""
        echo -e "${GREEN}✓ Migration 014 applied successfully!${NC}"
        print_summary
    else
        echo ""
        echo -e "${RED}✗ Migration failed. Please check the error messages above.${NC}"
        exit 1
    fi
else
    if psql -U $DB_USER -d $DB_NAME -f "$MIGRATION_PATH"; then
        echo ""
        echo -e "${GREEN}✓ Migration 014 applied successfully!${NC}"
        print_summary
    else
        echo ""
        echo -e "${RED}✗ Migration failed. Please check the error messages above.${NC}"
        exit 1
    fi
fi

echo ""
echo "============================================================================"
