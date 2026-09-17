BEGIN;
-- Prices carry their slot through the immutable capture, unlike event rows.
CREATE FUNCTION dusk_ingestion.notify_native_price() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_slot BIGINT;
BEGIN
  SELECT slot INTO source_slot FROM dusk_ingestion.price_capture_observations WHERE capture_id=NEW.capture_id;
  PERFORM pg_notify('dusk_events_updated',json_build_object(
    'cluster',NEW.cluster,'programId',NEW.program_id,'idlHash',NEW.idl_hash,
    'protocolRevision',NEW.protocol_revision,'slot',source_slot)::text);
  RETURN NEW;
END $$;
DROP TRIGGER dusk_price_capture_notify ON dusk_ingestion.price_observations;
CREATE TRIGGER dusk_price_capture_notify AFTER INSERT ON dusk_ingestion.price_observations
  FOR EACH ROW EXECUTE FUNCTION dusk_ingestion.notify_native_price();
COMMIT;
