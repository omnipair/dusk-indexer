BEGIN;
ALTER TABLE dusk_ingestion.price_capture_observations
  ADD COLUMN market_state_basis TEXT NOT NULL DEFAULT 'rpc-account'
  CHECK(market_state_basis IN ('rpc-account','simulation-post-state'));
ALTER TABLE dusk_ingestion.price_capture_observations
  ADD CONSTRAINT dusk_price_simulated_market_slot CHECK(market_state_basis<>'simulation-post-state' OR market_slot=slot);
COMMIT;
