BEGIN;

ALTER TABLE keeper_work_items
  DROP CONSTRAINT keeper_job_kind_valid;

ALTER TABLE keeper_work_items
  ADD CONSTRAINT keeper_job_kind_valid CHECK (
    job_kind IN (
      'leverage_liquidation',
      'lending_liquidation_trigger',
      'lending_liquidation_bid',
      'lending_liquidation_settle',
      'hlp_recovery',
      'stop_loss',
      'take_profit',
      'auction_bid',
      'lifecycle',
      'sentinel'
    )
  );

COMMIT;
