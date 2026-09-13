#!/usr/bin/env bash
# Canonical Dusk bootstrap/upgrade. DATABASE_URL must name the target database.
# Creating or resetting a database is a separate explicit operator action.
set -euo pipefail
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
export DUSK_MIGRATE_ONLY=true
exec bash "$script_dir/../../scripts/dusk-indexer-entrypoint.sh"
