BEGIN;
-- Keep immutable evidence in its original tables. This narrow time-series is
-- the chart read projection, including captures still awaiting decoding.
LOCK TABLE dusk_ingestion.price_capture_observations, dusk_ingestion.market_quote_projections IN SHARE ROW EXCLUSIVE MODE;
CREATE TABLE dusk_ingestion.quote_series (
  time TIMESTAMPTZ NOT NULL,
  capture_id BIGINT NOT NULL REFERENCES dusk_ingestion.price_capture_observations(capture_id),
  cluster TEXT NOT NULL, program_id TEXT NOT NULL, idl_hash TEXT NOT NULL, protocol_revision TEXT NOT NULL,
  deployment_identity_sha256 TEXT NOT NULL, market TEXT NOT NULL, slot BIGINT NOT NULL,
  base_mint TEXT, quote_mint TEXT, base_decimals SMALLINT, quote_decimals SMALLINT,
  base_spot_price_nad NUMERIC(20,0), quote_spot_price_nad NUMERIC(20,0),
  PRIMARY KEY (capture_id,time)
);
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname='timescaledb') THEN
    PERFORM create_hypertable('dusk_ingestion.quote_series','time',chunk_time_interval=>INTERVAL '7 days');
  END IF;
END $$;
CREATE INDEX dusk_quote_series_market_time ON dusk_ingestion.quote_series
  (cluster,program_id,idl_hash,protocol_revision,market,time DESC,slot);
INSERT INTO dusk_ingestion.quote_series
  SELECT o.block_time,o.capture_id,o.cluster,o.program_id,o.idl_hash,o.protocol_revision,
    o.deployment_identity_sha256,o.market,o.slot,q.base_mint,q.quote_mint,q.base_decimals,q.quote_decimals,
    q.base_spot_price_nad,q.quote_spot_price_nad
  FROM dusk_ingestion.price_capture_observations o
  LEFT JOIN dusk_ingestion.market_quote_projections q USING(capture_id);

-- A transactionally serialized revision catches late inserts and projections.
-- Capture IDs alone are unsafe cursors: allocation order is not commit order.
CREATE TABLE dusk_ingestion.quote_history_state (
  cluster TEXT NOT NULL, program_id TEXT NOT NULL, idl_hash TEXT NOT NULL, protocol_revision TEXT NOT NULL,
  revision BIGINT NOT NULL CHECK(revision>=0), conflicted BOOLEAN NOT NULL,
  PRIMARY KEY(cluster,program_id,idl_hash,protocol_revision)
);
INSERT INTO dusk_ingestion.quote_history_state
  SELECT cluster,program_id,idl_hash,protocol_revision,1,bool_or(conflict)
  FROM (SELECT cluster,program_id,idl_hash,protocol_revision,market,slot,
    count(DISTINCT(blockhash,preview_hash,block_time))>1 AS conflict
    FROM dusk_ingestion.price_capture_observations GROUP BY 1,2,3,4,5,6) banks GROUP BY 1,2,3,4;
CREATE TABLE dusk_ingestion.quote_history_changes (
  cluster TEXT NOT NULL, program_id TEXT NOT NULL, idl_hash TEXT NOT NULL, protocol_revision TEXT NOT NULL,
  market TEXT NOT NULL, minute TIMESTAMPTZ NOT NULL, revision BIGINT NOT NULL,
  PRIMARY KEY(cluster,program_id,idl_hash,protocol_revision,market,minute)
);
CREATE INDEX dusk_quote_changes_revision ON dusk_ingestion.quote_history_changes
  (cluster,program_id,idl_hash,protocol_revision,market,revision);

CREATE FUNCTION dusk_ingestion.record_quote_change(source dusk_ingestion.price_capture_observations, conflict BOOLEAN)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE next_revision BIGINT;
BEGIN
  INSERT INTO dusk_ingestion.quote_history_state VALUES
    (source.cluster,source.program_id,source.idl_hash,source.protocol_revision,1,conflict)
  ON CONFLICT(cluster,program_id,idl_hash,protocol_revision) DO UPDATE SET
    revision=quote_history_state.revision+1,conflicted=quote_history_state.conflicted OR EXCLUDED.conflicted
  RETURNING revision INTO next_revision;
  INSERT INTO dusk_ingestion.quote_history_changes VALUES
    (source.cluster,source.program_id,source.idl_hash,source.protocol_revision,source.market,
      date_trunc('minute',source.block_time),next_revision)
  ON CONFLICT(cluster,program_id,idl_hash,protocol_revision,market,minute) DO UPDATE SET revision=EXCLUDED.revision;
END $$;

CREATE FUNCTION dusk_ingestion.lock_quote_capture() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Same lock/order and compact identity key as the projection worker.
  PERFORM pg_advisory_xact_lock(hashtextextended('dusk:prices:['||
    to_json(NEW.cluster)::text||','||to_json(NEW.program_id)::text||','||
    to_json(NEW.idl_hash)::text||','||to_json(NEW.protocol_revision)::text||']',0));
  RETURN NEW;
END $$;
CREATE TRIGGER dusk_quote_capture_lock BEFORE INSERT ON dusk_ingestion.price_capture_observations
  FOR EACH ROW EXECUTE FUNCTION dusk_ingestion.lock_quote_capture();
CREATE FUNCTION dusk_ingestion.capture_quote_series() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM dusk_ingestion.record_quote_change(NEW,EXISTS(
    SELECT 1 FROM dusk_ingestion.price_capture_observations o
    WHERE (o.cluster,o.program_id,o.idl_hash,o.protocol_revision,o.market,o.slot)=
      (NEW.cluster,NEW.program_id,NEW.idl_hash,NEW.protocol_revision,NEW.market,NEW.slot)
      AND (o.blockhash,o.preview_hash,o.block_time) IS DISTINCT FROM (NEW.blockhash,NEW.preview_hash,NEW.block_time)));
  INSERT INTO dusk_ingestion.quote_series(time,capture_id,cluster,program_id,idl_hash,protocol_revision,
    deployment_identity_sha256,market,slot)
    VALUES(NEW.block_time,NEW.capture_id,NEW.cluster,NEW.program_id,NEW.idl_hash,NEW.protocol_revision,
      NEW.deployment_identity_sha256,NEW.market,NEW.slot);
  RETURN NEW;
END $$;
CREATE TRIGGER dusk_quote_series_capture AFTER INSERT ON dusk_ingestion.price_capture_observations
  FOR EACH ROW EXECUTE FUNCTION dusk_ingestion.capture_quote_series();
CREATE FUNCTION dusk_ingestion.project_quote_series() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source dusk_ingestion.price_capture_observations%ROWTYPE;
BEGIN
  SELECT * INTO STRICT source FROM dusk_ingestion.price_capture_observations WHERE capture_id=NEW.capture_id;
  PERFORM dusk_ingestion.record_quote_change(source,false);
  UPDATE dusk_ingestion.quote_series SET base_mint=NEW.base_mint,quote_mint=NEW.quote_mint,
    base_decimals=NEW.base_decimals,quote_decimals=NEW.quote_decimals,
    base_spot_price_nad=NEW.base_spot_price_nad,quote_spot_price_nad=NEW.quote_spot_price_nad
    WHERE capture_id=NEW.capture_id AND time=source.block_time;
  RETURN NEW;
END $$;
CREATE TRIGGER dusk_quote_series_projection AFTER INSERT ON dusk_ingestion.market_quote_projections
  FOR EACH ROW EXECUTE FUNCTION dusk_ingestion.project_quote_series();

CREATE FUNCTION dusk_ingestion.register_quote_history_deployment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source dusk_ingestion.price_capture_observations%ROWTYPE;
BEGIN
  -- Registering an older compatible API release can expose previously excluded
  -- captures. Treat it as a backfill, even though no price row was inserted.
  FOR source IN SELECT DISTINCT ON(market,date_trunc('minute',block_time)) *
    FROM dusk_ingestion.price_capture_observations
    WHERE deployment_identity_sha256=NEW.deployment_identity_sha256
  LOOP
    PERFORM dusk_ingestion.record_quote_change(source,false);
  END LOOP;
  RETURN NEW;
END $$;
CREATE TRIGGER dusk_quote_history_deployment AFTER INSERT ON dusk_ingestion.capture_deployments
  FOR EACH ROW EXECUTE FUNCTION dusk_ingestion.register_quote_history_deployment();

-- The projection cannot manufacture a source, relabel a market, or rewrite a
-- completed quote. Reads still verify OHLC witnesses against saved bytes.
CREATE FUNCTION dusk_ingestion.guard_quote_series() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR (TG_OP='UPDATE' AND OLD.base_mint IS NOT NULL) THEN
    RAISE EXCEPTION 'FINALIZED_INVARIANT: immutable quote series';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM dusk_ingestion.price_capture_observations o
    LEFT JOIN dusk_ingestion.market_quote_projections q USING(capture_id)
    WHERE o.capture_id=NEW.capture_id AND
      (o.block_time,o.cluster,o.program_id,o.idl_hash,o.protocol_revision,o.deployment_identity_sha256,o.market,o.slot,
        q.base_mint,q.quote_mint,q.base_decimals,q.quote_decimals,q.base_spot_price_nad,q.quote_spot_price_nad)
      IS NOT DISTINCT FROM
      (NEW.time,NEW.cluster,NEW.program_id,NEW.idl_hash,NEW.protocol_revision,NEW.deployment_identity_sha256,NEW.market,NEW.slot,
        NEW.base_mint,NEW.quote_mint,NEW.base_decimals,NEW.quote_decimals,NEW.base_spot_price_nad,NEW.quote_spot_price_nad)) THEN
    RAISE EXCEPTION 'FINALIZED_INVARIANT: quote series differs from its source';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER dusk_quote_series_guard BEFORE INSERT OR UPDATE OR DELETE ON dusk_ingestion.quote_series
  FOR EACH ROW EXECUTE FUNCTION dusk_ingestion.guard_quote_series();
DO $migration$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_extension WHERE extname='timescaledb') THEN
    EXECUTE $definition$CREATE FUNCTION dusk_ingestion.quote_bucket(t TIMESTAMPTZ, seconds INTEGER)
      RETURNS TIMESTAMPTZ LANGUAGE SQL IMMUTABLE PARALLEL SAFE AS
      'SELECT time_bucket(make_interval(secs => seconds),t)'$definition$;
  ELSE
    EXECUTE $definition$CREATE FUNCTION dusk_ingestion.quote_bucket(t TIMESTAMPTZ, seconds INTEGER)
      RETURNS TIMESTAMPTZ LANGUAGE SQL IMMUTABLE PARALLEL SAFE AS
      'SELECT to_timestamp(floor(extract(epoch FROM t)/seconds)*seconds)'$definition$;
  END IF;
END $migration$;
COMMIT;
