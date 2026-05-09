-- Migration: Add PostgreSQL LISTEN/NOTIFY trigger for pools
-- Description: Sends a notification when a pool row is inserted or updated so
--              that consumers (e.g. the API process) can invalidate cached
--              `pools:enriched:*` entries built by PoolController.fetchAllPools.
-- Channel:     pool_updates
--
-- The indexer's `upsert_pair_created_event` performs INSERT ... ON CONFLICT DO
-- UPDATE on the pools table, so this trigger fires for both brand-new pools
-- (from PairCreatedEvent) and re-emits of an existing pool's parameters.

CREATE OR REPLACE FUNCTION notify_pool_updated()
RETURNS TRIGGER AS $$
BEGIN
    PERFORM pg_notify(
        'pool_updates',
        json_build_object(
            'op', TG_OP,
            'id', NEW.id::text,
            'pair', NEW.pair_address,
            'token0', NEW.token0,
            'token1', NEW.token1,
            'visible', NEW.visible
        )::text
    );
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS pools_notify ON pools;

CREATE TRIGGER pools_notify
AFTER INSERT OR UPDATE ON pools
FOR EACH ROW
EXECUTE FUNCTION notify_pool_updated();

DO $$
BEGIN
    RAISE NOTICE 'Migration 013: Successfully created pool_updates NOTIFY trigger on pools';
END $$;
