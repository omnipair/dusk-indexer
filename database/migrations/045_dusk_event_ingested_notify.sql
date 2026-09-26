BEGIN;
-- Projection workers wake on every event the daemon writes, as the v1 volume
-- enricher wakes on each swap. `dusk_events_updated` also fires for the
-- projections' own rows, so it cannot wake them without waking them again.

CREATE FUNCTION dusk_ingestion.notify_event_ingested() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('dusk_event_ingested', json_build_object(
    'cluster',NEW.cluster,'protocolRevision',NEW.protocol_revision,'slot',NEW.slot)::text);
  RETURN NEW;
END $$;
CREATE TRIGGER dusk_event_ingested_notify AFTER INSERT ON dusk_ingestion.event_stream
  FOR EACH ROW EXECUTE FUNCTION dusk_ingestion.notify_event_ingested();
COMMIT;
