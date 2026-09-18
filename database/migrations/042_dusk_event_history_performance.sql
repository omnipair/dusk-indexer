BEGIN;
-- Serialize the one-time backfill with writers. Raw observations remain the
-- authority; these indexes and this state only accelerate their read path.
LOCK TABLE dusk_ingestion.event_observations, dusk_ingestion.canonical_events,
  dusk_ingestion.event_stream IN SHARE ROW EXCLUSIVE MODE;

CREATE FUNCTION dusk_ingestion.event_history_actor(name TEXT, payload JSONB)
RETURNS TEXT LANGUAGE SQL IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE name WHEN 'SwapExecuted' THEN payload->>'trader'
    WHEN 'BorrowPositionLiquidated' THEN payload->>'borrower'
    ELSE payload->>'owner' END
$$;
CREATE INDEX dusk_history_actor_page ON dusk_ingestion.event_observations
  (cluster,program_id,idl_hash,protocol_revision,
   dusk_ingestion.event_history_actor(event_name,decoded_payload),slot DESC,event_key DESC)
  WHERE commitment='finalized';
CREATE INDEX dusk_history_liquidator_page ON dusk_ingestion.event_observations
  (cluster,program_id,idl_hash,protocol_revision,(decoded_payload->>'liquidator'),slot DESC,event_key DESC)
  WHERE commitment='finalized' AND event_name IN ('BorrowPositionLiquidated','LeveragePositionLiquidated')
    AND dusk_ingestion.event_history_actor(event_name,decoded_payload) IS DISTINCT FROM decoded_payload->>'liquidator';
CREATE INDEX dusk_history_market_page ON dusk_ingestion.event_observations
  (cluster,program_id,idl_hash,protocol_revision,(decoded_payload->>'market'),slot DESC,event_key DESC)
  WHERE commitment='finalized';
CREATE INDEX dusk_history_page ON dusk_ingestion.event_observations
  (cluster,program_id,idl_hash,protocol_revision,slot DESC,event_key DESC)
  WHERE commitment='finalized';

CREATE INDEX dusk_history_watermark ON dusk_ingestion.event_observations
  (cluster,program_id,idl_hash,protocol_revision,observation_id DESC);

CREATE TABLE dusk_ingestion.event_history_state (
  cluster TEXT NOT NULL, program_id TEXT NOT NULL, idl_hash TEXT NOT NULL, protocol_revision TEXT NOT NULL,
  revision BIGINT NOT NULL CHECK(revision>=0), last_statement BIGINT NOT NULL,
  conflicted BOOLEAN NOT NULL,
  PRIMARY KEY(cluster,program_id,idl_hash,protocol_revision)
);
INSERT INTO dusk_ingestion.event_history_state
  SELECT cluster,program_id,idl_hash,protocol_revision,1,0,bool_or(conflict)
  FROM (SELECT cluster,program_id,idl_hash,protocol_revision,event_key,
    count(DISTINCT(blockhash,slot,payload_hash,event_name)) FILTER(WHERE commitment='finalized')>1 AS conflict
    FROM dusk_ingestion.event_observations GROUP BY 1,2,3,4,5) events GROUP BY 1,2,3,4;

-- This is a conflict sentinel, never a fork-choice or price projection. Keep
-- one immutable comparison tuple per finalized event and halt the identity on
-- any difference. A unique-key upsert avoids re-scanning observations per row
-- (especially before planner statistics catch up during a bulk import).
CREATE TABLE dusk_ingestion.event_history_finalized_witnesses (
  cluster TEXT NOT NULL, program_id TEXT NOT NULL, idl_hash TEXT NOT NULL, protocol_revision TEXT NOT NULL,
  event_key TEXT NOT NULL, evidence JSONB NOT NULL,
  PRIMARY KEY(cluster,program_id,idl_hash,protocol_revision,event_key)
);
INSERT INTO dusk_ingestion.event_history_finalized_witnesses
  SELECT DISTINCT ON(cluster,program_id,idl_hash,protocol_revision,event_key)
    cluster,program_id,idl_hash,protocol_revision,event_key,
    jsonb_build_array(blockhash,slot,payload_hash,event_name)
  FROM dusk_ingestion.event_observations WHERE commitment='finalized'
  ORDER BY cluster,program_id,idl_hash,protocol_revision,event_key,observation_id;

-- One revision update per statement, including bulk replay. A unique statement
-- token avoids a long HOT-update chain on the state row during a large insert.
-- Each source table has its own transaction-local token so nested writes to
-- another source table cannot replace the outer statement's token.
CREATE SEQUENCE dusk_ingestion.event_history_statement_seq;
CREATE FUNCTION dusk_ingestion.begin_event_history_statement()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('dusk.history_statement_'||TG_ARGV[0],
    nextval('dusk_ingestion.event_history_statement_seq')::text,true);
  RETURN NULL;
END $$;
CREATE FUNCTION dusk_ingestion.bump_event_history(identity_row JSONB, statement_token BIGINT)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO dusk_ingestion.event_history_state VALUES
    (identity_row->>'cluster',identity_row->>'program_id',identity_row->>'idl_hash',
     identity_row->>'protocol_revision',1,statement_token,false)
  ON CONFLICT(cluster,program_id,idl_hash,protocol_revision) DO UPDATE SET
    revision=event_history_state.revision+1,last_statement=EXCLUDED.last_statement
    WHERE event_history_state.last_statement<>EXCLUDED.last_statement;
END $$;

CREATE FUNCTION dusk_ingestion.record_event_history_change()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source JSONB; statement_token BIGINT; witness JSONB;
BEGIN
  statement_token=current_setting('dusk.history_statement_'||TG_ARGV[0])::bigint;
  -- Updates that move identities invalidate both domains. Deletes can never
  -- erase a recorded conflict or cause a previous cache revision to reappear.
  IF TG_OP<>'INSERT' THEN
    PERFORM dusk_ingestion.bump_event_history(to_jsonb(OLD),statement_token);
  END IF;
  IF TG_OP<>'DELETE' THEN
    source=to_jsonb(NEW);
    PERFORM dusk_ingestion.bump_event_history(source,statement_token);
    IF TG_ARGV[0]='event_observations' THEN
      -- The identity lock precedes the unique-key witness upsert. A second
      -- concurrent writer compares with the first committed witness, including
      -- when both observations are in one bulk statement.
      IF NEW.commitment='finalized' THEN
        INSERT INTO dusk_ingestion.event_history_finalized_witnesses VALUES
          (NEW.cluster,NEW.program_id,NEW.idl_hash,NEW.protocol_revision,NEW.event_key,
           jsonb_build_array(NEW.blockhash,NEW.slot,NEW.payload_hash,NEW.event_name))
        ON CONFLICT(cluster,program_id,idl_hash,protocol_revision,event_key)
          DO UPDATE SET evidence=event_history_finalized_witnesses.evidence
        RETURNING evidence INTO witness;
        IF witness IS DISTINCT FROM jsonb_build_array(NEW.blockhash,NEW.slot,NEW.payload_hash,NEW.event_name) THEN
          UPDATE dusk_ingestion.event_history_state SET conflicted=true
          WHERE NOT conflicted AND (cluster,program_id,idl_hash,protocol_revision)=
            (NEW.cluster,NEW.program_id,NEW.idl_hash,NEW.protocol_revision);
        END IF;
      END IF;
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER dusk_event_history_observation_statement BEFORE INSERT OR UPDATE OR DELETE ON dusk_ingestion.event_observations
  FOR EACH STATEMENT EXECUTE FUNCTION dusk_ingestion.begin_event_history_statement('event_observations');
CREATE TRIGGER dusk_event_history_canonical_statement BEFORE INSERT OR UPDATE OR DELETE ON dusk_ingestion.canonical_events
  FOR EACH STATEMENT EXECUTE FUNCTION dusk_ingestion.begin_event_history_statement('canonical_events');
CREATE TRIGGER dusk_event_history_stream_statement BEFORE INSERT OR UPDATE OR DELETE ON dusk_ingestion.event_stream
  FOR EACH STATEMENT EXECUTE FUNCTION dusk_ingestion.begin_event_history_statement('event_stream');
CREATE TRIGGER dusk_event_history_observation AFTER INSERT OR UPDATE OR DELETE ON dusk_ingestion.event_observations
  FOR EACH ROW EXECUTE FUNCTION dusk_ingestion.record_event_history_change('event_observations');
CREATE TRIGGER dusk_event_history_canonical AFTER INSERT OR UPDATE OR DELETE ON dusk_ingestion.canonical_events
  FOR EACH ROW EXECUTE FUNCTION dusk_ingestion.record_event_history_change('canonical_events');
CREATE TRIGGER dusk_event_history_stream AFTER INSERT OR UPDATE OR DELETE ON dusk_ingestion.event_stream
  FOR EACH ROW EXECUTE FUNCTION dusk_ingestion.record_event_history_change('event_stream');
COMMIT;
