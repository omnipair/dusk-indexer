#!/bin/bash
# ============================================================================
# Apply Migration 007: Add LP fee and protocol fee breakdown columns to swaps
# ============================================================================
# Description: This script applies the 007_add_fee_breakdown_columns.sql
#              migration which adds lp_fee, protocol_fee, lp_fee_usd, and
#              protocol_fee_usd columns to the swaps table and updates the
#              swap notification trigger to include the new fields.
#
# Usage:
#   # Option 1: Using DATABASE_URL environment variable
#   DATABASE_URL="postgresql://user:password@host:port/dbname" ./apply_007_migration.sh
#   
#   # Option 2: Pass DATABASE_URL as argument
#   ./apply_007_migration.sh "postgresql://user:password@host:port/dbname"
#   
#   # Option 3: Use default user/database (legacy mode)
#   ./apply_007_migration.sh
#
# Prerequisites:
#   - PostgreSQL client installed
#   - Database connection configured (via DATABASE_URL or default settings)
#   - Migrations 001 through 006 must already be applied
# ============================================================================

set -e  # Exit on error

# Configuration
MIGRATION_FILE="../migrations/007_add_fee_breakdown_columns.sql"
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
echo "Applying Migration 007: Add fee breakdown columns to swaps table"
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
        echo -e "${GREEN}✓ Migration 007 applied successfully!${NC}"
        echo ""
        echo "Changes:"
        echo "  - Added 'lp_fee' column to swaps table (NUMERIC)"
        echo "  - Added 'protocol_fee' column to swaps table (NUMERIC)"
        echo "  - Added 'lp_fee_usd' column to swaps table (NUMERIC, default NULL)"
        echo "  - Added 'protocol_fee_usd' column to swaps table (NUMERIC, default NULL)"
        echo "  - Updated notify_swap_updated() trigger to include lp_fee and protocol_fee"
    else
        echo ""
        echo -e "${RED}✗ Migration failed. Please check the error messages above.${NC}"
        exit 1
    fi
else
    # Use DB_USER and DB_NAME
    if psql -U $DB_USER -d $DB_NAME -f "$MIGRATION_PATH"; then
        echo ""
        echo -e "${GREEN}✓ Migration 007 applied successfully!${NC}"
        echo ""
        echo "Changes:"
        echo "  - Added 'lp_fee' column to swaps table (NUMERIC)"
        echo "  - Added 'protocol_fee' column to swaps table (NUMERIC)"
        echo "  - Added 'lp_fee_usd' column to swaps table (NUMERIC, default NULL)"
        echo "  - Added 'protocol_fee_usd' column to swaps table (NUMERIC, default NULL)"
        echo "  - Updated notify_swap_updated() trigger to include lp_fee and protocol_fee"
    else
        echo ""
        echo -e "${RED}✗ Migration failed. Please check the error messages above.${NC}"
        exit 1
    fi
fi

echo ""
echo "============================================================================"
