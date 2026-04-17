#!/bin/bash
# ============================================================================
# Apply Migration 011: Add composite (pair, timestamp) index to swaps
# ============================================================================
# Description: This script applies the 011_add_swaps_pair_timestamp_index.sql
#              migration which adds a composite index on (pair, timestamp DESC)
#              to the swaps table for efficient candle/chart/volume queries.
#
# Usage:
#   # Option 1: Using DATABASE_URL environment variable
#   DATABASE_URL="postgresql://user:password@host:port/dbname" ./apply_011_migration.sh
#
#   # Option 2: Pass DATABASE_URL as argument
#   ./apply_011_migration.sh "postgresql://user:password@host:port/dbname"
#
#   # Option 3: Use default user/database (legacy mode)
#   ./apply_011_migration.sh
#
# Prerequisites:
#   - PostgreSQL client installed
#   - Database connection configured (via DATABASE_URL or default settings)
#   - Migrations 001 through 010 must already be applied
# ============================================================================

set -e  # Exit on error

# Configuration
MIGRATION_FILE="../migrations/011_add_swaps_pair_timestamp_index.sql"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIGRATION_PATH="$SCRIPT_DIR/$MIGRATION_FILE"

# Check if DATABASE_URL is provided as argument or environment variable
if [ -n "$1" ]; then
    DATABASE_URL="$1"
elif [ -z "$DATABASE_URL" ]; then
    # Fallback to default user/database if no DATABASE_URL provided
    DB_USER="omnipair_user"
    DB_NAME="omnipair_indexer"
fi

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "============================================================================"
echo "Applying Migration 011: Add composite (pair, timestamp) index to swaps"
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
echo "NOTE: This uses CREATE INDEX CONCURRENTLY, so it will not block writes."
echo "      It may take a few minutes on large tables."
echo ""

# Check if migration file exists
if [ ! -f "$MIGRATION_PATH" ]; then
    echo -e "${RED}Error: Migration file not found at $MIGRATION_PATH${NC}"
    exit 1
fi

# Confirm before applying
read -p "Do you want to apply this migration? (y/n) " -n 1 -r
echo ""

if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo -e "${YELLOW}Migration cancelled.${NC}"
    exit 0
fi

# Apply migration
echo "Applying migration..."
if [ -n "$DATABASE_URL" ]; then
    if psql "$DATABASE_URL" -f "$MIGRATION_PATH"; then
        echo ""
        echo -e "${GREEN}✓ Migration 011 applied successfully!${NC}"
        echo ""
        echo "Changes:"
        echo "  - Added index idx_swaps_pair_timestamp (pair, timestamp DESC) to swaps"
        echo ""
        echo "This index optimizes: candle queries, price charts, swap volume, fee queries."
    else
        echo ""
        echo -e "${RED}✗ Migration failed. Please check the error messages above.${NC}"
        exit 1
    fi
else
    if psql -U $DB_USER -d $DB_NAME -f "$MIGRATION_PATH"; then
        echo ""
        echo -e "${GREEN}✓ Migration 011 applied successfully!${NC}"
        echo ""
        echo "Changes:"
        echo "  - Added index idx_swaps_pair_timestamp (pair, timestamp DESC) to swaps"
        echo ""
        echo "This index optimizes: candle queries, price charts, swap volume, fee queries."
    else
        echo ""
        echo -e "${RED}✗ Migration failed. Please check the error messages above.${NC}"
        exit 1
    fi
fi

echo ""
echo "============================================================================"
