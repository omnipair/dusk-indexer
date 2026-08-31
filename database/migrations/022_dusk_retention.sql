-- Retention for the Dusk event stream.
--
-- The stream grows without bound, and a full volume takes reads down with it
-- while keepers keep running — the failure looks like the app is broken when
-- the chain is fine. A policy set now costs nothing; one set during the
-- outage costs the outage.
--
-- Ninety days is chosen to outlast any chart the app draws, so expiring a
-- chunk never blanks a view someone is looking at. Raw observations are
-- dropped sooner: they exist to reconcile canonical events and are dead weight
-- once that has happened.
--
-- Guarded like the hypertable itself, so a deployment without TimescaleDB
-- applies this file and gets nothing rather than failing.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
    RAISE NOTICE 'timescaledb is absent; retention is not configured';
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1 FROM timescaledb_information.hypertables
    WHERE hypertable_schema = 'dusk_ingestion' AND hypertable_name = 'event_stream'
  ) THEN
    -- add_retention_policy is idempotent only via if_not_exists; without it a
    -- re-run of the migration fails on an existing policy.
    PERFORM add_retention_policy(
      'dusk_ingestion.event_stream',
      INTERVAL '90 days',
      if_not_exists => TRUE
    );
    RAISE NOTICE 'event_stream retains 90 days';
  END IF;

  IF EXISTS (
    SELECT 1 FROM timescaledb_information.hypertables
    WHERE hypertable_schema = 'dusk_ingestion' AND hypertable_name = 'event_observations'
  ) THEN
    PERFORM add_retention_policy(
      'dusk_ingestion.event_observations',
      INTERVAL '14 days',
      if_not_exists => TRUE
    );
    RAISE NOTICE 'event_observations retains 14 days';
  END IF;
END
$$;
