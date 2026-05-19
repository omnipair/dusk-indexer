-- ============================================================================
-- Migration: Add categories column to pools
-- ============================================================================
-- Description: Adds a free-form `categories` TEXT column to the `pools` table
--              that stores a comma-separated list of category tags (e.g.
--              "defi,stable"). The API exposes this column as an array of
--              strings on the /pools endpoint by splitting on commas.
--
--              The column is nullable and defaults to NULL so existing rows
--              are unaffected. An empty / NULL value is treated as "no
--              categories" by the API.
--
-- Prerequisites:
--   - Migrations 001 through 013 must be applied
--
-- Usage:
--   psql -U omnipair_user -d omnipair_indexer -f 014_add_pools_categories.sql
-- ============================================================================

ALTER TABLE pools
ADD COLUMN IF NOT EXISTS categories TEXT;

COMMENT ON COLUMN pools.categories IS
    'Comma-separated list of category tags for the pool (e.g. "defi,stable"). '
    'Returned as an array of strings by the /pools API endpoint.';

DO $$
BEGIN
    RAISE NOTICE 'Migration 014: Added categories column to pools';
END $$;
