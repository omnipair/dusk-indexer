-- Native projections must outlive chart retention and retain full protocol identity.
BEGIN;
ALTER TABLE dusk_ingestion.event_stream ADD COLUMN IF NOT EXISTS idl_hash TEXT;
ALTER TABLE dusk_ingestion.event_stream ADD COLUMN IF NOT EXISTS protocol_revision TEXT;
UPDATE dusk_ingestion.event_stream s SET idl_hash = o.idl_hash, protocol_revision = o.protocol_revision
FROM dusk_ingestion.canonical_events c
JOIN dusk_ingestion.event_observations o USING (cluster, program_id, idl_hash, protocol_revision, event_key, observation_id)
WHERE s.cluster = c.cluster AND s.program_id = c.program_id AND s.event_key = c.event_key
  AND (s.idl_hash IS NULL OR s.protocol_revision IS NULL);
-- Refuse ambiguous legacy rows. Never infer an identity from current configuration.
ALTER TABLE dusk_ingestion.event_stream ALTER COLUMN idl_hash SET NOT NULL;
ALTER TABLE dusk_ingestion.event_stream ALTER COLUMN protocol_revision SET NOT NULL;
CREATE INDEX IF NOT EXISTS dusk_event_stream_identity_time_idx ON dusk_ingestion.event_stream
  (cluster, program_id, idl_hash, protocol_revision, time DESC);

CREATE OR REPLACE FUNCTION dusk_ingestion.enforce_finalized_observation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.commitment = 'finalized' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'FINALIZED_INVARIANT: finalized observation is immutable';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS dusk_finalized_observation_immutable ON dusk_ingestion.event_observations;
CREATE TRIGGER dusk_finalized_observation_immutable BEFORE UPDATE ON dusk_ingestion.event_observations
  FOR EACH ROW EXECUTE FUNCTION dusk_ingestion.enforce_finalized_observation();

CREATE OR REPLACE FUNCTION dusk_ingestion.enforce_finalized_pointer() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.commitment = 'finalized' AND (NEW.observation_id <> OLD.observation_id OR NEW.commitment <> 'finalized') THEN
    RAISE EXCEPTION 'FINALIZED_INVARIANT: contradictory finalized canonical observation';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS dusk_finalized_pointer_immutable ON dusk_ingestion.canonical_events;
CREATE TRIGGER dusk_finalized_pointer_immutable BEFORE UPDATE ON dusk_ingestion.canonical_events
  FOR EACH ROW EXECUTE FUNCTION dusk_ingestion.enforce_finalized_pointer();

-- Existing history-backed compatibility views still depend on the entire stream.
-- Remove the old retention jobs until durable projections and archive coverage
-- make it possible to prune without changing balances or losing replay inputs.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
    PERFORM remove_retention_policy('dusk_ingestion.event_stream', if_exists => TRUE);
    IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables
      WHERE hypertable_schema = 'dusk_ingestion' AND hypertable_name = 'event_observations') THEN
      PERFORM remove_retention_policy('dusk_ingestion.event_observations', if_exists => TRUE);
    END IF;
  END IF;
END $$;
COMMIT;
