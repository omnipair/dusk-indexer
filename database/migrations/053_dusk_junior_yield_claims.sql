BEGIN;
-- YieldClaimed uses 0=srLP, 1=hLP, 2=jrLP. Keep the source/provenance and
-- immutable-history guards while admitting the junior cash flows already
-- accepted by the event decoder and API projection.
ALTER TABLE dusk_ingestion.yield_claims
  DROP CONSTRAINT yield_claims_token_kind_check;
ALTER TABLE dusk_ingestion.yield_claims
  ADD CONSTRAINT yield_claims_token_kind_check CHECK (token_kind IN (0,1,2));
COMMIT;
