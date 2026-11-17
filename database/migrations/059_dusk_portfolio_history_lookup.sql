BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
-- A bounded chart window must seek by capture time after the complete
-- protocol identity and owner, rather than scanning that owner's entire life.
-- Retain the slot/capture tie-breakers used by pagination and sampling.
CREATE INDEX dusk_portfolio_owner_time ON dusk_ingestion.portfolio_checkpoints
  (cluster,program_id,idl_hash,protocol_revision,owner,bucket DESC,source_max_slot DESC,capture_id DESC);
COMMIT;
