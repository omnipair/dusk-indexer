BEGIN;
-- Raw observations are replay evidence. Application retries may read them;
-- neither retries nor maintenance may silently rewrite finalized account data.
CREATE OR REPLACE FUNCTION dusk_ingestion.reject_account_observation_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'FINALIZED_INVARIANT: account observations are immutable';
END $$;
CREATE TRIGGER dusk_account_observation_immutable
  BEFORE UPDATE OR DELETE ON dusk_ingestion.account_observations
  FOR EACH ROW EXECUTE FUNCTION dusk_ingestion.reject_account_observation_mutation();

CREATE OR REPLACE FUNCTION dusk_ingestion.check_account_projection_identity()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM dusk_ingestion.account_scans s WHERE s.scan_id = NEW.scan_id
    AND (s.cluster,s.program_id,s.idl_hash,s.protocol_revision) =
        (NEW.cluster,NEW.program_id,NEW.idl_hash,NEW.protocol_revision)) THEN
    RAISE EXCEPTION 'FINALIZED_INVARIANT: projection and account scan identities differ';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER dusk_account_projection_identity
  BEFORE INSERT OR UPDATE ON dusk_ingestion.account_projections
  FOR EACH ROW EXECUTE FUNCTION dusk_ingestion.check_account_projection_identity();

CREATE OR REPLACE FUNCTION dusk_ingestion.notify_native_event()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('dusk_events_updated', json_build_object(
    'cluster',NEW.cluster,'programId',NEW.program_id,'idlHash',NEW.idl_hash,
    'protocolRevision',NEW.protocol_revision,'slot',NEW.slot)::text);
  RETURN NEW;
END $$;
CREATE TRIGGER dusk_native_event_notify AFTER INSERT ON dusk_ingestion.event_stream
  FOR EACH ROW EXECUTE FUNCTION dusk_ingestion.notify_native_event();
COMMIT;
