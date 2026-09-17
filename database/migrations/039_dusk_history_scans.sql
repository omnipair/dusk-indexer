-- A cursor/heartbeat proves liveness, not history coverage. Only a complete
-- finalized address scan, reconciled with every decoded transaction, extends
-- this append-only chain. Existing cursors deliberately do not seed it.
BEGIN;
CREATE TABLE dusk_ingestion.history_scans (
  cluster TEXT NOT NULL,
  program_id TEXT NOT NULL,
  idl_hash TEXT NOT NULL,
  protocol_revision TEXT NOT NULL,
  from_slot BIGINT NOT NULL,
  through_slot BIGINT NOT NULL CHECK (through_slot >= from_slot),
  boundary_signature TEXT NOT NULL CHECK (boundary_signature ~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$'),
  boundary_slot BIGINT NOT NULL CHECK (boundary_slot >= 0 AND boundary_slot < from_slot),
  through_blockhash TEXT NOT NULL CHECK (through_blockhash ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  through_block_time TIMESTAMPTZ NOT NULL,
  release_block_time TIMESTAMPTZ NOT NULL,
  transactions JSONB NOT NULL CHECK (jsonb_typeof(transactions)='array'),
  completed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (cluster,program_id,idl_hash,protocol_revision,through_slot),
  FOREIGN KEY (cluster,program_id,idl_hash,protocol_revision)
    REFERENCES dusk_ingestion.protocol_identities(cluster,program_id,idl_hash,protocol_revision)
);

CREATE FUNCTION dusk_ingestion.guard_history_scan() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  deployment dusk_ingestion.deployment_intervals%ROWTYPE;
  previous dusk_ingestion.history_scans%ROWTYPE;
  receipt JSONB;
  actual_keys JSONB;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'FINALIZED_INVARIANT: history scans are immutable';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('dusk-history|'||NEW.cluster||'|'||NEW.protocol_revision,0));
  SELECT * INTO deployment FROM dusk_ingestion.deployment_intervals
    WHERE cluster=NEW.cluster AND protocol_revision=NEW.protocol_revision;
  IF NOT FOUND OR NEW.from_slot<deployment.first_slot OR NEW.through_slot>deployment.verified_through_slot
    OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(deployment.pin->'programs') p
      WHERE p->>'name'='dusk' AND p->>'programId'=NEW.program_id AND p->'idl'->>'canonicalSha256'=NEW.idl_hash) THEN
    RAISE EXCEPTION 'FINALIZED_INVARIANT: scan is outside its deployed identity';
  END IF;
  SELECT * INTO previous FROM dusk_ingestion.history_scans
    WHERE (cluster,program_id,idl_hash,protocol_revision)=(NEW.cluster,NEW.program_id,NEW.idl_hash,NEW.protocol_revision)
    ORDER BY through_slot DESC LIMIT 1;
  IF NEW.from_slot IS DISTINCT FROM COALESCE(previous.through_slot+1,deployment.first_slot)
    OR (previous.release_block_time IS NOT NULL AND NEW.release_block_time<>previous.release_block_time)
    OR NEW.through_block_time<COALESCE(previous.through_block_time,NEW.release_block_time)
    OR NEW.through_block_time>NEW.completed_at THEN
    RAISE EXCEPTION 'FINALIZED_INVARIANT: history scan skipped or regressed a boundary';
  END IF;
  IF (SELECT count(DISTINCT r->>'signature') FROM jsonb_array_elements(NEW.transactions) r)<>jsonb_array_length(NEW.transactions) THEN
    RAISE EXCEPTION 'FINALIZED_INVARIANT: repeated scanned transaction';
  END IF;
  FOR receipt IN SELECT value FROM jsonb_array_elements(NEW.transactions) LOOP
    IF COALESCE(receipt->>'signature','') !~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$'
      OR COALESCE((receipt->>'slot')::bigint,-1) NOT BETWEEN NEW.from_slot AND NEW.through_slot
      OR COALESCE(receipt->>'blockhash','') !~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
      OR COALESCE(receipt->>'transactionSha256','') !~ '^[0-9a-f]{64}$'
      OR jsonb_typeof(receipt->'failed') IS DISTINCT FROM 'boolean'
      OR jsonb_typeof(receipt->'eventKeys') IS DISTINCT FROM 'array'
      OR (receipt->>'failed')::boolean AND jsonb_array_length(receipt->'eventKeys')<>0 THEN
      RAISE EXCEPTION 'FINALIZED_INVARIANT: invalid scanned transaction receipt';
    END IF;
    SELECT COALESCE(jsonb_agg(c.event_key ORDER BY c.event_key),'[]'::jsonb) INTO actual_keys
      FROM dusk_ingestion.canonical_events c JOIN dusk_ingestion.event_observations o
        USING(cluster,program_id,idl_hash,protocol_revision,event_key,observation_id)
      WHERE c.cluster=NEW.cluster AND c.protocol_revision=NEW.protocol_revision
        AND o.transaction_signature=receipt->>'signature'
        AND c.commitment='finalized' AND o.commitment='finalized'
        AND o.slot=(receipt->>'slot')::bigint AND o.blockhash=receipt->>'blockhash';
    IF actual_keys IS DISTINCT FROM receipt->'eventKeys' THEN
      RAISE EXCEPTION 'FINALIZED_INVARIANT: scan advanced before every event was projected';
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM dusk_ingestion.canonical_events c
    JOIN dusk_ingestion.event_observations o USING(cluster,program_id,idl_hash,protocol_revision,event_key,observation_id)
    WHERE c.cluster=NEW.cluster AND c.protocol_revision=NEW.protocol_revision AND c.commitment='finalized'
      AND o.slot BETWEEN NEW.from_slot AND NEW.through_slot AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(NEW.transactions) r WHERE r->>'signature'=o.transaction_signature
          AND (r->>'slot')::bigint=o.slot AND r->>'blockhash'=o.blockhash AND r->'eventKeys' ? c.event_key)) THEN
    RAISE EXCEPTION 'FINALIZED_INVARIANT: signature scan omitted a known canonical event';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_history_scan BEFORE INSERT OR UPDATE OR DELETE ON dusk_ingestion.history_scans
  FOR EACH ROW EXECUTE FUNCTION dusk_ingestion.guard_history_scan();

-- Preserve a contradictory observation, but halt before accepting a canonical
-- event that was absent from an already-completed finalized scan.
CREATE FUNCTION dusk_ingestion.guard_scanned_canonical_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE observation dusk_ingestion.event_observations%ROWTYPE;
BEGIN
  IF NEW.commitment<>'finalized' THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('dusk-history|'||NEW.cluster||'|'||NEW.protocol_revision,0));
  SELECT * INTO observation FROM dusk_ingestion.event_observations WHERE observation_id=NEW.observation_id;
  IF EXISTS (SELECT 1 FROM dusk_ingestion.history_scans s WHERE s.cluster=NEW.cluster
    AND s.protocol_revision=NEW.protocol_revision AND observation.slot BETWEEN s.from_slot AND s.through_slot
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(s.transactions) r
      WHERE r->>'signature'=observation.transaction_signature AND (r->>'slot')::bigint=observation.slot
        AND r->>'blockhash'=observation.blockhash AND r->'eventKeys' ? NEW.event_key)) THEN
    RAISE EXCEPTION 'FINALIZED_INVARIANT: finalized event contradicts completed history scan';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_scanned_canonical_event BEFORE INSERT OR UPDATE ON dusk_ingestion.canonical_events
  FOR EACH ROW EXECUTE FUNCTION dusk_ingestion.guard_scanned_canonical_event();
COMMIT;
