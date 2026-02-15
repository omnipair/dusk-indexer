-- ============================================================================
-- DANGER: Truncate ALL Data from ALL Tables
-- ============================================================================
-- This script removes ALL rows from every table in the database while
-- preserving the schema (tables, columns, indexes, constraints, enums,
-- hypertables, extensions, sequences).
--
-- What it DOES:
--   - TRUNCATE all tables (removes every row)
--   - RESTART IDENTITY (resets all SERIAL / BIGSERIAL sequences to 1)
--   - CASCADE (handles foreign-key and hypertable chunk dependencies)
--
-- What it does NOT do:
--   - Drop any tables, indexes, constraints, enums, or extensions
--   - Alter any column definitions or defaults
--
-- Usage:
--   psql $DATABASE_URL -f truncate_all_data.sql
-- ============================================================================

BEGIN;

-- -------------------------------------------------------------------------
-- Safety check: abort if connected to a production-looking database
-- (Uncomment and adjust the hostname check below for your environment)
-- -------------------------------------------------------------------------
-- DO $$
-- BEGIN
--     IF current_setting('listen_addresses', true) IS NOT NULL THEN
--         RAISE EXCEPTION 'Refusing to run on a non-local database. Override this check if you are sure.';
--     END IF;
-- END $$;

-- -------------------------------------------------------------------------
-- Truncate all application tables
-- RESTART IDENTITY resets auto-increment counters back to 1
-- CASCADE is required for TimescaleDB hypertable chunks
-- -------------------------------------------------------------------------

TRUNCATE TABLE
    pools,
    swaps,
    adjust_liquidity,
    user_liquidity_positions,
    user_lp_position_updated_events,
    user_borrow_positions,
    user_position_updated_events,
    user_position_liquidated_events,
    adjust_collateral_events,
    adjust_debt_events,
    leverage_position_created_events,
    leverage_position_updated_events,
    whitelisted_tokens
RESTART IDENTITY CASCADE;

-- -------------------------------------------------------------------------
-- Verification: print row counts to confirm everything is empty
-- -------------------------------------------------------------------------

DO $$
DECLARE
    tbl TEXT;
    cnt BIGINT;
    tables TEXT[] := ARRAY[
        'pools',
        'swaps',
        'adjust_liquidity',
        'user_liquidity_positions',
        'user_lp_position_updated_events',
        'user_borrow_positions',
        'user_position_updated_events',
        'user_position_liquidated_events',
        'adjust_collateral_events',
        'adjust_debt_events',
        'leverage_position_created_events',
        'leverage_position_updated_events',
        'whitelisted_tokens'
    ];
BEGIN
    RAISE NOTICE '========================================';
    RAISE NOTICE 'TRUNCATION COMPLETE — Verifying counts:';
    RAISE NOTICE '========================================';
    FOREACH tbl IN ARRAY tables
    LOOP
        EXECUTE format('SELECT count(*) FROM %I', tbl) INTO cnt;
        RAISE NOTICE '  %-45s  rows: %', tbl, cnt;
    END LOOP;
    RAISE NOTICE '========================================';
    RAISE NOTICE 'All tables are now empty. Schema intact.';
    RAISE NOTICE '========================================';
END $$;

COMMIT;
