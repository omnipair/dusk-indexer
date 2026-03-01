-- Migration: Activity history performance indexes + invalidation notifications

-- ----------------------------------------------------------------------------
-- Query indexes for activity history access patterns
-- ----------------------------------------------------------------------------

-- Swaps access from GET /users/:userAddress/swaps
CREATE INDEX IF NOT EXISTS idx_swaps_user_timestamp_desc
  ON swaps USING btree (user_address, "timestamp" DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_swaps_user_pair_timestamp_desc
  ON swaps USING btree (user_address, pair, "timestamp" DESC, id DESC);

-- Liquidity access from GET /users/:userAddress/liquidity-events
CREATE INDEX IF NOT EXISTS idx_adjust_liquidity_user_timestamp_desc
  ON adjust_liquidity USING btree (user_address, "timestamp" DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_adjust_liquidity_user_pair_timestamp_desc
  ON adjust_liquidity USING btree (user_address, pair, "timestamp" DESC, id DESC);

-- Lending access from GET /users/:userAddress/lending-events and /activity
CREATE INDEX IF NOT EXISTS idx_adjust_collateral_signer_pair_event_ts_desc
  ON adjust_collateral_events USING btree (signer, pair, event_timestamp DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_adjust_debt_signer_pair_event_ts_desc
  ON adjust_debt_events USING btree (signer, pair, event_timestamp DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_user_position_liquidated_signer_pair_event_ts_desc
  ON user_position_liquidated_events USING btree (signer, pair, event_timestamp DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_user_position_updated_signer_pair_event_ts_desc
  ON user_position_updated_events USING btree (signer, pair, event_timestamp DESC, id DESC);

-- ----------------------------------------------------------------------------
-- Notification functions for cache invalidation on new indexed events
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION notify_activity_update()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM pg_notify(
    'activity_updates',
    json_build_object(
      'category', TG_ARGV[0],
      'table', TG_TABLE_NAME,
      'op', TG_OP,
      'user_address', COALESCE(NEW.user_address, NEW.signer),
      'pair', NEW.pair,
      'event_timestamp', COALESCE(NEW.timestamp, NEW.event_timestamp)
    )::text
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS activity_notify_adjust_liquidity ON adjust_liquidity;
CREATE TRIGGER activity_notify_adjust_liquidity
AFTER INSERT ON adjust_liquidity
FOR EACH ROW EXECUTE FUNCTION notify_activity_update('liquidity');

DROP TRIGGER IF EXISTS activity_notify_adjust_collateral_events ON adjust_collateral_events;
CREATE TRIGGER activity_notify_adjust_collateral_events
AFTER INSERT ON adjust_collateral_events
FOR EACH ROW EXECUTE FUNCTION notify_activity_update('lending');

DROP TRIGGER IF EXISTS activity_notify_adjust_debt_events ON adjust_debt_events;
CREATE TRIGGER activity_notify_adjust_debt_events
AFTER INSERT ON adjust_debt_events
FOR EACH ROW EXECUTE FUNCTION notify_activity_update('lending');

DROP TRIGGER IF EXISTS activity_notify_user_position_liquidated_events ON user_position_liquidated_events;
CREATE TRIGGER activity_notify_user_position_liquidated_events
AFTER INSERT ON user_position_liquidated_events
FOR EACH ROW EXECUTE FUNCTION notify_activity_update('lending');

DROP TRIGGER IF EXISTS activity_notify_user_position_updated_events ON user_position_updated_events;
CREATE TRIGGER activity_notify_user_position_updated_events
AFTER INSERT ON user_position_updated_events
FOR EACH ROW EXECUTE FUNCTION notify_activity_update('lending');
