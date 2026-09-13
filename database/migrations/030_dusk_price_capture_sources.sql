BEGIN;
CREATE TABLE dusk_ingestion.price_capture_observations (
  capture_id BIGSERIAL PRIMARY KEY,
  cluster TEXT NOT NULL, program_id TEXT NOT NULL, idl_hash TEXT NOT NULL, protocol_revision TEXT NOT NULL,
  market TEXT NOT NULL, slot BIGINT NOT NULL CHECK(slot>=0), market_slot BIGINT NOT NULL CHECK(market_slot BETWEEN 0 AND slot),
  blockhash TEXT NOT NULL, block_time TIMESTAMPTZ NOT NULL CHECK(isfinite(block_time)),
  observed_at TIMESTAMPTZ NOT NULL CHECK(isfinite(observed_at) AND observed_at>=block_time),
  deployment_identity_sha256 TEXT NOT NULL CHECK(deployment_identity_sha256 ~ '^[0-9a-f]{64}$'),
  raw_market BYTEA NOT NULL, raw_preview BYTEA NOT NULL,
  reference_config JSONB NOT NULL CHECK(jsonb_typeof(reference_config)='object'),
  content_hash TEXT NOT NULL CHECK(content_hash ~ '^[0-9a-f]{64}$'),
  preview_hash TEXT NOT NULL CHECK(preview_hash ~ '^[0-9a-f]{64}$'),
  UNIQUE(cluster,program_id,idl_hash,protocol_revision,market,slot,content_hash),
  FOREIGN KEY(cluster,program_id,idl_hash,protocol_revision)
    REFERENCES dusk_ingestion.protocol_identities(cluster,program_id,idl_hash,protocol_revision)
);
CREATE TRIGGER dusk_price_capture_immutable BEFORE UPDATE OR DELETE ON dusk_ingestion.price_capture_observations
  FOR EACH ROW EXECUTE FUNCTION dusk_ingestion.reject_account_observation_mutation();
CREATE TABLE dusk_ingestion.price_capture_projections (
  capture_id BIGINT PRIMARY KEY REFERENCES dusk_ingestion.price_capture_observations(capture_id),
  price_count SMALLINT NOT NULL CHECK(price_count BETWEEN 0 AND 2),
  projected_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER dusk_price_capture_projection_immutable BEFORE UPDATE OR DELETE ON dusk_ingestion.price_capture_projections
  FOR EACH ROW EXECUTE FUNCTION dusk_ingestion.reject_account_observation_mutation();
ALTER TABLE dusk_ingestion.price_observations ADD COLUMN capture_id BIGINT REFERENCES dusk_ingestion.price_capture_observations(capture_id);
CREATE INDEX dusk_price_history_lookup ON dusk_ingestion.price_observations(cluster,program_id,idl_hash,protocol_revision,mint,source_time DESC);
CREATE FUNCTION dusk_ingestion.check_price_capture_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.capture_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM dusk_ingestion.price_capture_observations o WHERE
    (o.cluster,o.program_id,o.idl_hash,o.protocol_revision,o.capture_id)=
      (NEW.cluster,NEW.program_id,NEW.idl_hash,NEW.protocol_revision,NEW.capture_id)
    AND o.block_time=NEW.source_time AND o.observed_at=NEW.observed_at
    AND (o.reference_config->>'effectiveFrom')::timestamptz<=NEW.source_time
    AND o.reference_config->'references' @> jsonb_build_array(NEW.source_evidence->'reference')
    AND NEW.source='dusk-preview.v1:'||o.market||':'||(NEW.source_evidence->>'referenceHash')||':'||o.slot::text
    AND ((NEW.quality='configured-reference'
          AND NEW.source_evidence->'reference'->>'mint'=NEW.mint
          AND (NEW.source_evidence->'reference'->>'priceUsd')::numeric=NEW.price_usd)
      OR (NEW.quality='derived-reference'
          AND NEW.source_evidence->'reference'->>'mint'<>NEW.mint
          AND (NEW.source_evidence->>'spotPriceNad')::numeric BETWEEN 1 AND 18446744073709551615
          AND NEW.price_usd=trunc((NEW.source_evidence->'reference'->>'priceUsd')::numeric
            *(NEW.source_evidence->>'spotPriceNad')::numeric*0.000000001::numeric,36)))
    AND NEW.source_evidence @> jsonb_build_object('captureId',o.capture_id::text,'market',o.market,
      'sourceSlot',o.slot::text,'blockhash',o.blockhash,'previewHash',o.preview_hash,
      'deploymentIdentitySha256',o.deployment_identity_sha256)) THEN
    RAISE EXCEPTION 'FINALIZED_INVARIANT: price projection differs from its captured source';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER dusk_price_capture_source BEFORE INSERT ON dusk_ingestion.price_observations
  FOR EACH ROW EXECUTE FUNCTION dusk_ingestion.check_price_capture_source();
CREATE TRIGGER dusk_price_capture_notify AFTER INSERT ON dusk_ingestion.price_observations
  FOR EACH ROW EXECUTE FUNCTION dusk_ingestion.notify_native_event();
COMMIT;
