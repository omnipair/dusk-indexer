BEGIN;
-- Relative quotes also update when USD valuation is unavailable. Their identity
-- and slot come from the immutable capture, never from a client-supplied hint.
CREATE FUNCTION dusk_ingestion.notify_native_quote() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source dusk_ingestion.price_capture_observations%ROWTYPE;
BEGIN
  SELECT * INTO STRICT source FROM dusk_ingestion.price_capture_observations WHERE capture_id=NEW.capture_id;
  PERFORM pg_notify('dusk_events_updated',json_build_object(
    'cluster',source.cluster,'programId',source.program_id,'idlHash',source.idl_hash,
    'protocolRevision',source.protocol_revision,'slot',source.slot)::text);
  RETURN NEW;
END $$;
CREATE TRIGGER dusk_quote_notify AFTER INSERT ON dusk_ingestion.market_quote_projections
  FOR EACH ROW EXECUTE FUNCTION dusk_ingestion.notify_native_quote();
COMMIT;
