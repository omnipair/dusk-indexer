#!/bin/bash
# ============================================================================
# Apply Migration 008: Create update_pair_events table for interest tracking
# ============================================================================
# Description: This script applies the 008_create_update_pair_events.sql
#              migration which creates the update_pair_events TimescaleDB
#              hypertable for storing interest accrual data from UpdatePairEvent.
#
# Usage:
#   # Option 1: Using DATABASE_URL environment variable
#   DATABASE_URL="postgresql://user:password@host:port/dbname" ./apply_008_migration.sh
#   
#   # Option 2: Pass DATABASE_URL as argument
#   ./apply_008_migration.sh "postgresql://user:password@host:port/dbname"
#   
#   # Option 3: Use default user/database (legacy mode)
#   ./apply_008_migration.sh
#
# Prerequisites:
#   - PostgreSQL client installed
#   - TimescaleDB extension enabled
#   - Database connection configured (via DATABASE_URL or default settings)
#   - Migrations 001 through 007 must already be applied
# ============================================================================

set -e  # Exit on error

# Configuration
MIGRATION_FILE="../migrations/008_create_update_pair_events.sql"
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
echo "Applying Migration 008: Create update_pair_events table"
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
    # Use DATABASE_URL
    if psql "$DATABASE_URL" -f "$MIGRATION_PATH"; then
        echo ""
        echo -e "${GREEN}✓ Migration 008 applied successfully!${NC}"
        echo ""
        echo "Changes:"
        echo "  - Created 'update_pair_events' table (TimescaleDB hypertable, 7-day chunks)"
        echo "  - Columns: pair, signer, price0_ema, price1_ema, rate0, rate1,"
        echo "    accrued_interest0/1, lp_interest0/1, protocol_interest0/1,"
        echo "    cash_reserve0/1, reserve0/1_after_interest, tx_sig, slot, timestamp"
        echo "  - Indexes on pair, timestamp, (pair+timestamp), slot"
    else
        echo ""
        echo -e "${RED}✗ Migration failed. Please check the error messages above.${NC}"
        exit 1
    fi
else
    # Use DB_USER and DB_NAME
    if psql -U $DB_USER -d $DB_NAME -f "$MIGRATION_PATH"; then
        echo ""
        echo -e "${GREEN}✓ Migration 008 applied successfully!${NC}"
        echo ""
        echo "Changes:"
        echo "  - Created 'update_pair_events' table (TimescaleDB hypertable, 7-day chunks)"
        echo "  - Columns: pair, signer, price0_ema, price1_ema, rate0, rate1,"
        echo "    accrued_interest0/1, lp_interest0/1, protocol_interest0/1,"
        echo "    cash_reserve0/1, reserve0/1_after_interest, tx_sig, slot, timestamp"
        echo "  - Indexes on pair, timestamp, (pair+timestamp), slot"
    else
        echo ""
        echo -e "${RED}✗ Migration failed. Please check the error messages above.${NC}"
        exit 1
    fi
fi

echo ""
echo "============================================================================"
