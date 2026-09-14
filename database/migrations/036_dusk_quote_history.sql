BEGIN;
-- Relative curve prices exist even when neither token has a configured USD
-- reference. Keep this projection independent of price_observations.
CREATE TABLE dusk_ingestion.market_quote_projections (
  capture_id BIGINT PRIMARY KEY REFERENCES dusk_ingestion.price_capture_observations(capture_id),
  base_mint TEXT NOT NULL, quote_mint TEXT NOT NULL CHECK(quote_mint<>base_mint),
  base_decimals SMALLINT NOT NULL CHECK(base_decimals BETWEEN 0 AND 255),
  quote_decimals SMALLINT NOT NULL CHECK(quote_decimals BETWEEN 0 AND 255),
  base_spot_price_nad NUMERIC(20,0) NOT NULL CHECK(base_spot_price_nad BETWEEN 0 AND 18446744073709551615),
  quote_spot_price_nad NUMERIC(20,0) NOT NULL CHECK(quote_spot_price_nad BETWEEN 0 AND 18446744073709551615),
  projected_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER dusk_market_quote_immutable BEFORE UPDATE OR DELETE ON dusk_ingestion.market_quote_projections
  FOR EACH ROW EXECUTE FUNCTION dusk_ingestion.reject_account_observation_mutation();
CREATE INDEX dusk_quote_capture_history ON dusk_ingestion.price_capture_observations
  (cluster,program_id,idl_hash,protocol_revision,deployment_identity_sha256,market,block_time,slot);
COMMIT;
