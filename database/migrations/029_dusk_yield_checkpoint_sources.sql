BEGIN;

-- Keep the coherent RPC evidence even when decoding or projection fails.
CREATE TABLE dusk_ingestion.yield_checkpoint_observations (
  observation_id BIGSERIAL PRIMARY KEY,
  cluster TEXT NOT NULL, program_id TEXT NOT NULL, idl_hash TEXT NOT NULL, protocol_revision TEXT NOT NULL,
  yield_account TEXT NOT NULL, market TEXT NOT NULL, lp_token_account TEXT NOT NULL,
  slot BIGINT NOT NULL CHECK(slot>=0), blockhash TEXT NOT NULL CHECK(blockhash<>''),
  block_time TIMESTAMPTZ NOT NULL CHECK(isfinite(block_time)),
  deployment_identity_sha256 TEXT NOT NULL CHECK(deployment_identity_sha256 ~ '^[0-9a-f]{64}$'),
  source_accounts JSONB NOT NULL CHECK(jsonb_typeof(source_accounts)='object'),
  content_hash TEXT NOT NULL CHECK(content_hash ~ '^[0-9a-f]{64}$'),
  observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(cluster,program_id,idl_hash,protocol_revision,yield_account,slot,content_hash),
  FOREIGN KEY(cluster,program_id,idl_hash,protocol_revision)
    REFERENCES dusk_ingestion.protocol_identities(cluster,program_id,idl_hash,protocol_revision)
);
CREATE TRIGGER dusk_yield_checkpoint_observation_immutable BEFORE UPDATE OR DELETE ON dusk_ingestion.yield_checkpoint_observations
  FOR EACH ROW EXECUTE FUNCTION dusk_ingestion.reject_account_observation_mutation();

ALTER TABLE dusk_ingestion.yield_checkpoints
  ADD COLUMN observation_id BIGINT NOT NULL REFERENCES dusk_ingestion.yield_checkpoint_observations(observation_id),
  ADD COLUMN basis TEXT NOT NULL DEFAULT 'recorded-growth.v1' CHECK(basis='recorded-growth.v1'),
  ADD COLUMN lp_token_account TEXT NOT NULL,
  ADD COLUMN asset_decimals SMALLINT NOT NULL CHECK(asset_decimals BETWEEN 0 AND 255),
  ADD COLUMN deployment_identity_sha256 TEXT NOT NULL CHECK(deployment_identity_sha256 ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT dusk_yield_checkpoint_finite_time CHECK(isfinite(block_time)),
  ADD CONSTRAINT dusk_yield_checkpoint_total_u64 CHECK(swap_fee_amount+interest_amount<=18446744073709551615);

CREATE FUNCTION dusk_ingestion.check_yield_checkpoint_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM dusk_ingestion.yield_checkpoint_observations o WHERE o.observation_id=NEW.observation_id
    AND (o.cluster,o.program_id,o.idl_hash,o.protocol_revision,o.yield_account,o.market,o.lp_token_account,o.slot,
         o.blockhash,o.block_time,o.content_hash,o.deployment_identity_sha256)=
        (NEW.cluster,NEW.program_id,NEW.idl_hash,NEW.protocol_revision,NEW.yield_account,NEW.market,NEW.lp_token_account,NEW.slot,
         NEW.blockhash,NEW.block_time,NEW.content_hash,NEW.deployment_identity_sha256)
    AND NEW.raw_yield=decode(o.source_accounts->'yield'->>'data','base64')
    AND NEW.raw_market=decode(o.source_accounts->'market'->>'data','base64')
    AND NEW.raw_lp_account IS NOT DISTINCT FROM decode(o.source_accounts->'lpToken'->>'data','base64')) THEN
    RAISE EXCEPTION 'FINALIZED_INVARIANT: yield checkpoint differs from its coherent RPC observation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER dusk_yield_checkpoint_source BEFORE INSERT ON dusk_ingestion.yield_checkpoints
  FOR EACH ROW EXECUTE FUNCTION dusk_ingestion.check_yield_checkpoint_source();
CREATE TRIGGER dusk_yield_checkpoint_notify AFTER INSERT ON dusk_ingestion.yield_checkpoints
  FOR EACH ROW EXECUTE FUNCTION dusk_ingestion.notify_native_event();

-- Claim projection polls only this event family, including late old-slot replay.
CREATE INDEX dusk_finalized_yield_claim_sources ON dusk_ingestion.event_observations
  (cluster,program_id,idl_hash,protocol_revision,slot,event_key)
  WHERE commitment='finalized' AND event_name='YieldClaimed';
COMMIT;
