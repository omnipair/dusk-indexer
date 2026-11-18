BEGIN;
CREATE TABLE dusk_ingestion.portfolio_market_catalog_observations (
  observation_id BIGSERIAL PRIMARY KEY,
  cluster TEXT NOT NULL, program_id TEXT NOT NULL, idl_hash TEXT NOT NULL, protocol_revision TEXT NOT NULL,
  slot BIGINT NOT NULL CHECK(slot>=0), blockhash TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL CHECK(isfinite(observed_at)),
  source JSONB NOT NULL CHECK(jsonb_typeof(source)='object' AND source->>'commitment'='finalized'
    AND jsonb_typeof(source->'markets')='array'),
  content_hash TEXT NOT NULL CHECK(content_hash ~ '^[0-9a-f]{64}$'),
  UNIQUE(cluster,program_id,idl_hash,protocol_revision,content_hash),
  FOREIGN KEY(cluster,program_id,idl_hash,protocol_revision)
    REFERENCES dusk_ingestion.protocol_identities(cluster,program_id,idl_hash,protocol_revision)
);
CREATE INDEX dusk_portfolio_catalog_bank ON dusk_ingestion.portfolio_market_catalog_observations
  (cluster,program_id,idl_hash,protocol_revision,slot);
CREATE TRIGGER dusk_portfolio_catalog_immutable BEFORE UPDATE OR DELETE ON dusk_ingestion.portfolio_market_catalog_observations
  FOR EACH ROW EXECUTE FUNCTION dusk_ingestion.reject_account_observation_mutation();
COMMIT;
