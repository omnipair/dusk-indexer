BEGIN;

-- Provider history is separate from contemporaneous live observations. A later
-- fetch never becomes a quote that was known to the original capture.
CREATE TABLE dusk_ingestion.historical_price_points (
  point_id BIGSERIAL PRIMARY KEY,
  cluster TEXT NOT NULL CHECK(cluster='mainnet-beta'), program_id TEXT NOT NULL,
  idl_hash TEXT NOT NULL, protocol_revision TEXT NOT NULL,
  provider TEXT NOT NULL CHECK(provider='birdeye'), mint TEXT NOT NULL,
  resolution TEXT NOT NULL CHECK(resolution='1m'),
  source_time TIMESTAMPTZ NOT NULL CHECK(isfinite(source_time) AND extract(epoch FROM source_time)::bigint%60=0),
  fetched_at TIMESTAMPTZ NOT NULL CHECK(isfinite(fetched_at) AND fetched_at>=source_time+interval '2 minutes'),
  price_usd NUMERIC NOT NULL CHECK(price_usd>0 AND price_usd<'Infinity'::numeric),
  evidence JSONB NOT NULL CHECK(jsonb_typeof(evidence)='object'),
  content_hash TEXT NOT NULL CHECK(content_hash ~ '^[0-9a-f]{64}$'),
  CHECK(evidence->>'provider'='birdeye' AND evidence->>'resolution'='1m'
    AND evidence->>'amountMode'='raw' AND evidence->>'mint'=mint
    AND (evidence->>'unixTime')::bigint=extract(epoch FROM source_time)::bigint
    AND (evidence->>'priceUsd')::numeric=price_usd),
  UNIQUE(cluster,program_id,idl_hash,protocol_revision,provider,mint,resolution,source_time),
  FOREIGN KEY(cluster,program_id,idl_hash,protocol_revision)
    REFERENCES dusk_ingestion.protocol_identities(cluster,program_id,idl_hash,protocol_revision)
);
CREATE TRIGGER dusk_historical_price_immutable BEFORE UPDATE OR DELETE ON dusk_ingestion.historical_price_points
  FOR EACH ROW EXECUTE FUNCTION dusk_ingestion.reject_account_observation_mutation();

CREATE TABLE dusk_ingestion.portfolio_price_repairs (
  repair_id BIGSERIAL PRIMARY KEY,
  capture_id BIGINT NOT NULL, owner TEXT NOT NULL,
  policy TEXT NOT NULL CHECK(policy='birdeye-minute.v1'),
  source_hash TEXT NOT NULL CHECK(source_hash ~ '^[0-9a-f]{64}$'),
  repaired_at TIMESTAMPTZ NOT NULL CHECK(isfinite(repaired_at)),
  components JSONB NOT NULL CHECK(jsonb_typeof(components)='array'),
  valuations JSONB NOT NULL CHECK(jsonb_typeof(valuations)='object'),
  price_evidence JSONB NOT NULL CHECK(jsonb_typeof(price_evidence)='array' AND jsonb_array_length(price_evidence)>0),
  content_hash TEXT NOT NULL CHECK(content_hash ~ '^[0-9a-f]{64}$'),
  UNIQUE(capture_id,owner),
  FOREIGN KEY(capture_id,owner) REFERENCES dusk_ingestion.portfolio_checkpoints(capture_id,owner)
);
CREATE TRIGGER dusk_portfolio_repair_immutable BEFORE UPDATE OR DELETE ON dusk_ingestion.portfolio_price_repairs
  FOR EACH ROW EXECUTE FUNCTION dusk_ingestion.reject_account_observation_mutation();

CREATE FUNCTION dusk_ingestion.check_portfolio_price_repair() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE original dusk_ingestion.portfolio_checkpoints%ROWTYPE; old_component JSONB; new_component JSONB;
BEGIN
  SELECT * INTO STRICT original FROM dusk_ingestion.portfolio_checkpoints WHERE capture_id=NEW.capture_id AND owner=NEW.owner;
  IF original.cluster<>'mainnet-beta' OR NEW.source_hash IS DISTINCT FROM original.coverage->>'sourceHash'
    OR (original.valuations->>'unvaluedComponents')::int<=0
    OR NEW.repaired_at<original.observed_at
    OR jsonb_array_length(original.components)<>jsonb_array_length(NEW.components)
    OR NEW.valuations->>'quality' IS DISTINCT FROM 'reference-valued'
    OR (NEW.valuations->>'unvaluedComponents')::int IS DISTINCT FROM 0
    OR NEW.valuations->>'netPositionValueUsd' IS NULL
    OR NEW.valuations->>'includesWalletBalances' IS DISTINCT FROM 'false'
    OR NEW.valuations->>'includesUnclaimedYield' IS DISTINCT FROM 'false' THEN
    RAISE EXCEPTION 'FINALIZED_INVARIANT: repair does not match its original portfolio capture';
  END IF;
  FOR old_component,new_component IN SELECT a.value,b.value FROM jsonb_array_elements(original.components) WITH ORDINALITY a
    JOIN jsonb_array_elements(NEW.components) WITH ORDINALITY b USING(ordinality) LOOP
    IF (old_component-'valuation'-'issues') IS DISTINCT FROM (new_component-'valuation'-'issues')
      OR new_component->'valuation'->>'netUsd' IS NULL
      OR new_component->'valuation'->'missingMints' IS DISTINCT FROM '[]'::jsonb
      OR new_component->'issues' IS DISTINCT FROM (SELECT coalesce(jsonb_agg(value),'[]'::jsonb)
        FROM jsonb_array_elements(old_component->'issues') WHERE value<>'"missing-price-reference"'::jsonb)
      OR (old_component->'valuation'->>'netUsd' IS NOT NULL AND old_component IS DISTINCT FROM new_component)
      OR (old_component->'valuation'->>'netUsd' IS NULL AND (NOT (old_component->'issues' ? 'missing-price-reference')
        OR old_component->'issues' ? 'market-preview-unavailable')) THEN
      RAISE EXCEPTION 'FINALIZED_INVARIANT: historical repair changed captured positions or non-price state';
    END IF;
    IF EXISTS(SELECT 1 FROM jsonb_array_elements_text(old_component->'valuation'->'missingMints') AS m(mint)
      WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.price_evidence) e
        JOIN dusk_ingestion.historical_price_points p ON p.point_id=(e->>'pointId')::bigint
        WHERE (p.cluster,p.program_id,p.idl_hash,p.protocol_revision)=(original.cluster,original.program_id,original.idl_hash,original.protocol_revision)
          AND e->>'component'=old_component->>'address' AND e->>'mint'=m.mint AND p.mint=m.mint
          AND e->>'contentHash'=p.content_hash
          AND (e->>'sourceTime')::timestamptz=p.source_time AND (e->>'fetchedAt')::timestamptz=p.fetched_at
          AND p.source_time<=(old_component->>'sourceTime')::timestamptz
          AND p.source_time>(old_component->>'sourceTime')::timestamptz-interval '1 minute'
          AND p.fetched_at<=NEW.repaired_at)) THEN
      RAISE EXCEPTION 'FINALIZED_INVARIANT: missing dated price evidence for historical repair';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;
CREATE TRIGGER dusk_portfolio_repair_source BEFORE INSERT ON dusk_ingestion.portfolio_price_repairs
  FOR EACH ROW EXECUTE FUNCTION dusk_ingestion.check_portfolio_price_repair();
CREATE TRIGGER dusk_portfolio_repair_notify AFTER INSERT ON dusk_ingestion.portfolio_price_repairs
  FOR EACH ROW EXECUTE FUNCTION dusk_ingestion.notify_native_portfolio();

-- Retry state is disposable scheduling metadata, not a rewritten observation.
CREATE TABLE dusk_ingestion.portfolio_price_repair_attempts (
  capture_id BIGINT PRIMARY KEY REFERENCES dusk_ingestion.portfolio_capture_observations(capture_id),
  attempts INTEGER NOT NULL CHECK(attempts>0), retry_after TIMESTAMPTZ NOT NULL CHECK(isfinite(retry_after)),
  last_status TEXT NOT NULL CHECK(last_status IN ('repaired','unavailable'))
);
CREATE INDEX dusk_portfolio_missing_prices ON dusk_ingestion.portfolio_checkpoints(capture_id)
  WHERE (valuations->>'unvaluedComponents')::int>0;

CREATE VIEW dusk_ingestion.portfolio_effective_checkpoints AS
SELECT c.cluster,c.program_id,c.idl_hash,c.protocol_revision,c.owner,c.bucket,c.observed_at,c.source_min_slot,c.source_max_slot,
  coalesce(r.components,c.components) AS components,
  CASE WHEN r.repair_id IS NULL THEN c.coverage ELSE c.coverage||jsonb_build_object('historicalPriceRepair',
    jsonb_build_object('basis',r.policy,'repairId',r.repair_id::text,'sourceHash',r.source_hash,
      'repairedAt',to_char(r.repaired_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'contentHash',r.content_hash,'priceEvidence',r.price_evidence)) END AS coverage,
  coalesce(r.valuations,c.valuations) AS valuations,c.capture_id,coalesce(r.content_hash,'original') AS valuation_revision
FROM dusk_ingestion.portfolio_checkpoints c LEFT JOIN dusk_ingestion.portfolio_price_repairs r USING(capture_id,owner);
COMMIT;
