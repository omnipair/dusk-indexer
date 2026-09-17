BEGIN;
CREATE TABLE dusk_ingestion.portfolio_capture_observations (
  capture_id BIGSERIAL PRIMARY KEY,
  cluster TEXT NOT NULL, program_id TEXT NOT NULL, idl_hash TEXT NOT NULL, protocol_revision TEXT NOT NULL,
  source_min_slot BIGINT NOT NULL CHECK(source_min_slot>=0),
  source_max_slot BIGINT NOT NULL CHECK(source_max_slot>=source_min_slot),
  capture_time TIMESTAMPTZ NOT NULL CHECK(isfinite(capture_time)),
  observed_at TIMESTAMPTZ NOT NULL CHECK(isfinite(observed_at) AND observed_at>=capture_time),
  deployment_identity_sha256 TEXT NOT NULL CHECK(deployment_identity_sha256 ~ '^[0-9a-f]{64}$'),
  source JSONB NOT NULL CHECK(jsonb_typeof(source)='object'),
  content_hash TEXT NOT NULL CHECK(content_hash ~ '^[0-9a-f]{64}$'),
  UNIQUE(cluster,program_id,idl_hash,protocol_revision,content_hash),
  FOREIGN KEY(cluster,program_id,idl_hash,protocol_revision)
    REFERENCES dusk_ingestion.protocol_identities(cluster,program_id,idl_hash,protocol_revision)
);
CREATE TRIGGER dusk_portfolio_capture_immutable BEFORE UPDATE OR DELETE ON dusk_ingestion.portfolio_capture_observations
  FOR EACH ROW EXECUTE FUNCTION dusk_ingestion.reject_account_observation_mutation();

-- Same-bank contradictions are retained as evidence and halt projection/reads.
-- Market simulations and unmodified RPC accounts have different state bases.
CREATE TABLE dusk_ingestion.portfolio_account_evidence (
  capture_id BIGINT NOT NULL REFERENCES dusk_ingestion.portfolio_capture_observations(capture_id),
  account TEXT NOT NULL, slot BIGINT NOT NULL CHECK(slot>=0),
  basis TEXT NOT NULL CHECK(basis IN ('simulation-post-state','rpc-account')),
  blockhash TEXT NOT NULL, state_hash TEXT NOT NULL CHECK(state_hash ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY(capture_id,account,slot,basis,state_hash)
);
CREATE INDEX dusk_portfolio_evidence_bank ON dusk_ingestion.portfolio_account_evidence(account,slot,basis);
CREATE TRIGGER dusk_portfolio_evidence_immutable BEFORE UPDATE OR DELETE ON dusk_ingestion.portfolio_account_evidence
  FOR EACH ROW EXECUTE FUNCTION dusk_ingestion.reject_account_observation_mutation();
CREATE TABLE dusk_ingestion.portfolio_capture_projections (
  capture_id BIGINT PRIMARY KEY REFERENCES dusk_ingestion.portfolio_capture_observations(capture_id),
  owner_count INTEGER NOT NULL CHECK(owner_count>=0), projected_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER dusk_portfolio_projection_immutable BEFORE UPDATE OR DELETE ON dusk_ingestion.portfolio_capture_projections
  FOR EACH ROW EXECUTE FUNCTION dusk_ingestion.reject_account_observation_mutation();

-- The reserved table has no prior native writer. Require source attribution;
-- an existing unattributed row deliberately stops migration for investigation.
ALTER TABLE dusk_ingestion.portfolio_checkpoints ADD COLUMN capture_id BIGINT NOT NULL
  REFERENCES dusk_ingestion.portfolio_capture_observations(capture_id);
ALTER TABLE dusk_ingestion.portfolio_checkpoints DROP CONSTRAINT portfolio_checkpoints_pkey;
ALTER TABLE dusk_ingestion.portfolio_checkpoints ADD PRIMARY KEY(capture_id,owner);
CREATE INDEX dusk_portfolio_owner_history ON dusk_ingestion.portfolio_checkpoints
  (cluster,program_id,idl_hash,protocol_revision,owner,source_max_slot DESC,capture_id DESC);

CREATE FUNCTION dusk_ingestion.check_portfolio_checkpoint_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE batch dusk_ingestion.portfolio_capture_observations%ROWTYPE;
BEGIN
  SELECT * INTO STRICT batch FROM dusk_ingestion.portfolio_capture_observations WHERE capture_id=NEW.capture_id;
  IF (NEW.cluster,NEW.program_id,NEW.idl_hash,NEW.protocol_revision,NEW.source_min_slot,NEW.source_max_slot,NEW.bucket,NEW.observed_at)
    IS DISTINCT FROM (batch.cluster,batch.program_id,batch.idl_hash,batch.protocol_revision,batch.source_min_slot,batch.source_max_slot,batch.capture_time,batch.observed_at)
    OR jsonb_typeof(NEW.components)<>'array' OR jsonb_typeof(NEW.coverage)<>'object' OR jsonb_typeof(NEW.valuations)<>'object'
    OR NEW.coverage->>'sourceHash' IS DISTINCT FROM batch.content_hash
    OR NEW.coverage->>'deploymentIdentitySha256' IS DISTINCT FROM batch.deployment_identity_sha256
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.components) c WHERE c->>'owner' IS DISTINCT FROM NEW.owner
      OR NOT EXISTS(SELECT 1 FROM dusk_ingestion.portfolio_account_evidence e
        WHERE e.capture_id=NEW.capture_id AND e.account=c->>'address' AND e.slot=(c->>'sourceSlot')::bigint AND e.basis='rpc-account'))
    OR (jsonb_array_length(NEW.components)=0 AND NOT (batch.source->'catalog'->'knownOwners' ? NEW.owner)) THEN
    RAISE EXCEPTION 'FINALIZED_INVARIANT: portfolio checkpoint differs from its captured source';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER dusk_portfolio_source BEFORE INSERT ON dusk_ingestion.portfolio_checkpoints
  FOR EACH ROW EXECUTE FUNCTION dusk_ingestion.check_portfolio_checkpoint_source();
CREATE FUNCTION dusk_ingestion.notify_native_portfolio() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE batch dusk_ingestion.portfolio_capture_observations%ROWTYPE;
BEGIN
  SELECT * INTO STRICT batch FROM dusk_ingestion.portfolio_capture_observations WHERE capture_id=NEW.capture_id;
  PERFORM pg_notify('dusk_events_updated',json_build_object('cluster',batch.cluster,'programId',batch.program_id,
    'idlHash',batch.idl_hash,'protocolRevision',batch.protocol_revision,'slot',batch.source_max_slot)::text);
  RETURN NEW;
END $$;
CREATE TRIGGER dusk_portfolio_notify AFTER INSERT ON dusk_ingestion.portfolio_capture_projections
  FOR EACH ROW EXECUTE FUNCTION dusk_ingestion.notify_native_portfolio();
COMMIT;
