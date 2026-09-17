BEGIN;

-- Durable observations, never views over today's holdings or prices.
CREATE TABLE dusk_ingestion.yield_checkpoints (
  cluster TEXT NOT NULL, program_id TEXT NOT NULL, idl_hash TEXT NOT NULL, protocol_revision TEXT NOT NULL,
  yield_account TEXT NOT NULL, owner TEXT NOT NULL, market TEXT NOT NULL, lp_mint TEXT NOT NULL, asset_mint TEXT NOT NULL,
  token_kind SMALLINT NOT NULL CHECK (token_kind IN (0,1)),
  slot BIGINT NOT NULL CHECK (slot>=0), blockhash TEXT NOT NULL, block_time TIMESTAMPTZ NOT NULL,
  lp_balance NUMERIC(20,0) NOT NULL CHECK (lp_balance BETWEEN 0 AND 18446744073709551615),
  swap_fee_amount NUMERIC(20,0) NOT NULL CHECK (swap_fee_amount BETWEEN 0 AND 18446744073709551615),
  interest_amount NUMERIC(20,0) NOT NULL CHECK (interest_amount BETWEEN 0 AND 18446744073709551615),
  swap_remainder_q64 NUMERIC(20,0) NOT NULL CHECK (swap_remainder_q64 BETWEEN 0 AND 18446744073709551615),
  interest_remainder_q64 NUMERIC(20,0) NOT NULL CHECK (interest_remainder_q64 BETWEEN 0 AND 18446744073709551615),
  raw_yield BYTEA NOT NULL, raw_market BYTEA NOT NULL, raw_lp_account BYTEA,
  content_hash TEXT NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'), observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(cluster,program_id,idl_hash,protocol_revision,yield_account,slot),
  FOREIGN KEY(cluster,program_id,idl_hash,protocol_revision) REFERENCES dusk_ingestion.protocol_identities(cluster,program_id,idl_hash,protocol_revision)
);
CREATE INDEX dusk_yield_history_owner ON dusk_ingestion.yield_checkpoints(cluster,program_id,idl_hash,protocol_revision,owner,block_time DESC);
CREATE TRIGGER dusk_yield_checkpoint_immutable BEFORE UPDATE OR DELETE ON dusk_ingestion.yield_checkpoints
  FOR EACH ROW EXECUTE FUNCTION dusk_ingestion.reject_account_observation_mutation();

-- A claim is a cash flow at the event time, not an accrual allocation. No
-- current LP balance is consulted. Gross entitlements and net credit differ
-- for assets with transfer fees and must remain separate.
CREATE TABLE dusk_ingestion.yield_claims (
  cluster TEXT NOT NULL, program_id TEXT NOT NULL, idl_hash TEXT NOT NULL, protocol_revision TEXT NOT NULL,
  event_key TEXT NOT NULL, observation_id BIGINT NOT NULL,
  signature TEXT NOT NULL, slot BIGINT NOT NULL CHECK(slot>=0), blockhash TEXT NOT NULL, block_time TIMESTAMPTZ NOT NULL CHECK(isfinite(block_time)),
  owner TEXT NOT NULL, market TEXT NOT NULL, lp_mint TEXT NOT NULL, asset_mint TEXT NOT NULL, recipient TEXT NOT NULL,
  token_kind SMALLINT NOT NULL CHECK(token_kind IN (0,1)),
  swap_fee_amount NUMERIC(20,0) NOT NULL CHECK(swap_fee_amount BETWEEN 0 AND 18446744073709551615),
  interest_amount NUMERIC(20,0) NOT NULL CHECK(interest_amount BETWEEN 0 AND 18446744073709551615),
  recipient_credit NUMERIC(20,0) NOT NULL CHECK(recipient_credit BETWEEN 0 AND 18446744073709551615),
  payload JSONB NOT NULL CHECK(jsonb_typeof(payload)='object'),
  projected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK(swap_fee_amount+interest_amount BETWEEN 1 AND 18446744073709551615),
  CHECK(recipient_credit<=swap_fee_amount+interest_amount),
  PRIMARY KEY(cluster,program_id,idl_hash,protocol_revision,event_key),
  FOREIGN KEY(cluster,program_id,idl_hash,protocol_revision,event_key)
    REFERENCES dusk_ingestion.canonical_events(cluster,program_id,idl_hash,protocol_revision,event_key),
  FOREIGN KEY(cluster,program_id,idl_hash,protocol_revision,event_key,observation_id)
    REFERENCES dusk_ingestion.event_observations(cluster,program_id,idl_hash,protocol_revision,event_key,observation_id)
);
CREATE INDEX dusk_yield_claim_owner ON dusk_ingestion.yield_claims(cluster,program_id,idl_hash,protocol_revision,owner,block_time DESC);
CREATE TRIGGER dusk_yield_claim_immutable BEFORE UPDATE OR DELETE ON dusk_ingestion.yield_claims
  FOR EACH ROW EXECUTE FUNCTION dusk_ingestion.reject_account_observation_mutation();

-- A projection must match the exact finalized source, including event time.
-- Checking only the event-key FK would allow another observation or identity
-- to be attached to a claim, or a caller to be substituted for its owner.
CREATE FUNCTION dusk_ingestion.check_yield_claim_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT count(*) FROM dusk_ingestion.canonical_events c
    JOIN dusk_ingestion.event_observations o USING(cluster,program_id,idl_hash,protocol_revision,event_key,observation_id)
    JOIN dusk_ingestion.event_stream s USING(cluster,program_id,idl_hash,protocol_revision,event_key)
    WHERE (c.cluster,c.program_id,c.idl_hash,c.protocol_revision,c.event_key,c.observation_id)=
      (NEW.cluster,NEW.program_id,NEW.idl_hash,NEW.protocol_revision,NEW.event_key,NEW.observation_id)
      AND c.commitment='finalized' AND o.commitment='finalized'
      AND o.event_name='YieldClaimed' AND s.event_name=o.event_name
      AND s.transaction_signature=o.transaction_signature AND s.slot=o.slot AND s.payload=o.decoded_payload
      AND s.time=NEW.block_time AND o.transaction_signature=NEW.signature
      AND o.slot=NEW.slot AND o.blockhash=NEW.blockhash AND o.decoded_payload=NEW.payload
      AND NEW.payload @> jsonb_build_object('owner',NEW.owner,'market',NEW.market,'lp_mint',NEW.lp_mint,
        'asset_mint',NEW.asset_mint,'recipient',NEW.recipient,'token_kind',NEW.token_kind::text,
        'swap_fee_amount',NEW.swap_fee_amount::text,'interest_amount',NEW.interest_amount::text,
        'recipient_credit',NEW.recipient_credit::text)) <> 1 THEN
    RAISE EXCEPTION 'FINALIZED_INVARIANT: yield claim does not match its finalized event';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER dusk_yield_claim_source BEFORE INSERT ON dusk_ingestion.yield_claims
  FOR EACH ROW EXECUTE FUNCTION dusk_ingestion.check_yield_claim_source();
CREATE TRIGGER dusk_yield_claim_notify AFTER INSERT ON dusk_ingestion.yield_claims
  FOR EACH ROW EXECUTE FUNCTION dusk_ingestion.notify_native_event();

CREATE TABLE dusk_ingestion.price_observations (
  observation_id BIGSERIAL PRIMARY KEY,
  cluster TEXT NOT NULL, program_id TEXT NOT NULL, idl_hash TEXT NOT NULL, protocol_revision TEXT NOT NULL,
  mint TEXT NOT NULL, decimals SMALLINT NOT NULL CHECK(decimals BETWEEN 0 AND 255),
  observed_at TIMESTAMPTZ NOT NULL CHECK(isfinite(observed_at)), source_time TIMESTAMPTZ NOT NULL CHECK(isfinite(source_time)),
  price_usd NUMERIC NOT NULL CHECK(price_usd>0 AND price_usd<'Infinity'::numeric),
  quality TEXT NOT NULL CHECK(quality IN ('external-observation','configured-reference','derived-reference')),
  source TEXT NOT NULL CHECK(source<>''), source_evidence JSONB NOT NULL CHECK(jsonb_typeof(source_evidence)='object'),
  CHECK(source_time<=observed_at),
  UNIQUE(cluster,program_id,idl_hash,protocol_revision,mint,source,source_time),
  FOREIGN KEY(cluster,program_id,idl_hash,protocol_revision) REFERENCES dusk_ingestion.protocol_identities(cluster,program_id,idl_hash,protocol_revision)
);
CREATE TRIGGER dusk_price_observation_immutable BEFORE UPDATE OR DELETE ON dusk_ingestion.price_observations
  FOR EACH ROW EXECUTE FUNCTION dusk_ingestion.reject_account_observation_mutation();

CREATE TABLE dusk_ingestion.portfolio_checkpoints (
  cluster TEXT NOT NULL, program_id TEXT NOT NULL, idl_hash TEXT NOT NULL, protocol_revision TEXT NOT NULL,
  owner TEXT NOT NULL, bucket TIMESTAMPTZ NOT NULL CHECK(isfinite(bucket)), observed_at TIMESTAMPTZ NOT NULL CHECK(isfinite(observed_at)),
  source_min_slot BIGINT NOT NULL CHECK(source_min_slot>=0), source_max_slot BIGINT NOT NULL CHECK(source_max_slot>=source_min_slot),
  components JSONB NOT NULL, coverage JSONB NOT NULL, valuations JSONB NOT NULL,
  CHECK(bucket<=observed_at),
  PRIMARY KEY(cluster,program_id,idl_hash,protocol_revision,owner,bucket),
  FOREIGN KEY(cluster,program_id,idl_hash,protocol_revision) REFERENCES dusk_ingestion.protocol_identities(cluster,program_id,idl_hash,protocol_revision)
);
CREATE TRIGGER dusk_portfolio_checkpoint_immutable BEFORE UPDATE OR DELETE ON dusk_ingestion.portfolio_checkpoints
  FOR EACH ROW EXECUTE FUNCTION dusk_ingestion.reject_account_observation_mutation();
COMMIT;
