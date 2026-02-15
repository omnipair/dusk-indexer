#!/bin/bash
# ============================================================================
# DANGER: Truncate ALL data from the Omnipair Indexer database
# ============================================================================
# This script will DELETE ALL ROWS from every table in the database.
# Schema (tables, indexes, constraints, enums) will be preserved.
#
# Usage:
#   ./database/scripts/truncate_all_data.sh
#
# Environment:
#   DATABASE_URL   — PostgreSQL connection string (reads from .env if not set)
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SQL_FILE="$SCRIPT_DIR/../migrations/truncate_all_data.sql"

# ---------------------------------------------------------------------------
# Load DATABASE_URL from .env if not already set
# ---------------------------------------------------------------------------
if [ -z "${DATABASE_URL:-}" ]; then
    if [ -f "$PROJECT_ROOT/.env" ]; then
        export $(grep -E '^DATABASE_URL=' "$PROJECT_ROOT/.env" | xargs)
    fi
fi

if [ -z "${DATABASE_URL:-}" ]; then
    echo "ERROR: DATABASE_URL is not set. Export it or add it to $PROJECT_ROOT/.env"
    exit 1
fi

# ---------------------------------------------------------------------------
# Extract host for display (mask credentials)
# ---------------------------------------------------------------------------
DB_HOST=$(echo "$DATABASE_URL" | sed -E 's|.*@([^:/]+).*|\1|')
DB_NAME=$(echo "$DATABASE_URL" | sed -E 's|.*/([^?]+).*|\1|')

# ---------------------------------------------------------------------------
# WARNING — Triple confirmation
# ---------------------------------------------------------------------------
echo ""
echo "╔══════════════════════════════════════════════════════════════════╗"
echo "║                                                                ║"
echo "║   ⚠️   WARNING: DESTRUCTIVE OPERATION   ⚠️                      ║"
echo "║                                                                ║"
echo "║   This will PERMANENTLY DELETE ALL DATA from every table       ║"
echo "║   in the database. This action CANNOT be undone.               ║"
echo "║                                                                ║"
echo "║   Database:  $DB_NAME"
echo "║   Host:      $DB_HOST"
echo "║                                                                ║"
echo "║   Tables that will be truncated:                               ║"
echo "║     - pools                                                    ║"
echo "║     - swaps                                                    ║"
echo "║     - adjust_liquidity                                         ║"
echo "║     - user_liquidity_positions                                 ║"
echo "║     - user_lp_position_updated_events                          ║"
echo "║     - user_borrow_positions                                    ║"
echo "║     - user_position_updated_events                             ║"
echo "║     - user_position_liquidated_events                          ║"
echo "║     - adjust_collateral_events                                 ║"
echo "║     - adjust_debt_events                                       ║"
echo "║     - leverage_position_created_events                         ║"
echo "║     - leverage_position_updated_events                         ║"
echo "║     - whitelisted_tokens                                       ║"
echo "║                                                                ║"
echo "╚══════════════════════════════════════════════════════════════════╝"
echo ""

read -p "Are you sure you want to delete ALL data? (type 'yes' to confirm): " CONFIRM1
if [ "$CONFIRM1" != "yes" ]; then
    echo "Aborted."
    exit 0
fi

echo ""
read -p "FINAL WARNING — Type the database name '$DB_NAME' to proceed: " CONFIRM2
if [ "$CONFIRM2" != "$DB_NAME" ]; then
    echo "Database name does not match. Aborted."
    exit 0
fi

echo ""
echo "Executing truncation..."
echo ""

psql "$DATABASE_URL" -f "$SQL_FILE"

echo ""
echo "Done. All data has been removed. Schema is intact."
