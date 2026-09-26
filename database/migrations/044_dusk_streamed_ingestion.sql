BEGIN;
-- Streamed ingestion writes confirmed events as they land, like the v1
-- indexer. The pinned deployment still gates every row by program, IDL and
-- the release's first slot; the last attested finalized slot no longer caps
-- it, and projections accept a confirmed canonical source.

CREATE OR REPLACE FUNCTION dusk_ingestion.guard_deployment_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE deployment dusk_ingestion.deployment_intervals%ROWTYPE;
BEGIN
    PERFORM pg_advisory_xact_lock_shared(hashtextextended('dusk-deployment|'||NEW.cluster||'|'||NEW.protocol_revision,0));
    SELECT * INTO deployment FROM dusk_ingestion.deployment_intervals
      WHERE cluster=NEW.cluster AND protocol_revision=NEW.protocol_revision;
    IF FOUND AND (NEW.slot<deployment.first_slot
      OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(deployment.pin->'programs') p
        WHERE p->>'programId'=NEW.program_id AND p->'idl'->>'canonicalSha256'=NEW.idl_hash)) THEN
        RAISE EXCEPTION 'FINALIZED_INVARIANT: event is outside its deployment identity or release';
    END IF;
    RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION dusk_ingestion.guard_deployment_cursor() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE deployment dusk_ingestion.deployment_intervals%ROWTYPE;
BEGIN
    PERFORM pg_advisory_xact_lock_shared(hashtextextended('dusk-deployment|'||NEW.cluster||'|'||NEW.protocol_revision,0));
    SELECT * INTO deployment FROM dusk_ingestion.deployment_intervals
      WHERE cluster=NEW.cluster AND protocol_revision=NEW.protocol_revision;
    IF FOUND AND (NEW.next_slot<deployment.first_slot OR NEW.last_observed_slot<deployment.first_slot
      OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(deployment.pin->'programs') p
        WHERE p->>'programId'=NEW.program_id AND p->'idl'->>'canonicalSha256'=NEW.idl_hash)) THEN
        RAISE EXCEPTION 'FINALIZED_INVARIANT: cursor is outside its deployment identity or release';
    END IF;
    RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION dusk_ingestion.record_order_instruction(
  p_cluster TEXT,p_program TEXT,p_idl TEXT,p_revision TEXT,p_key TEXT,p_signature TEXT,p_slot BIGINT,p_block TEXT,p_time BIGINT,p_path INTEGER[],
  p_name TEXT,p_order TEXT,p_owner TEXT,p_market TEXT,p_raw BYTEA,p_payload TEXT
) RETURNS BOOLEAN LANGUAGE plpgsql AS $$
DECLARE deployment dusk_ingestion.deployment_intervals%ROWTYPE; digest TEXT;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('dusk-order-history|'||p_cluster||'|'||p_revision,0));
  SELECT * INTO deployment FROM dusk_ingestion.deployment_intervals WHERE cluster=p_cluster AND protocol_revision=p_revision;
  IF NOT FOUND OR p_slot<deployment.first_slot
    OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(deployment.pin->'programs') p WHERE p->>'name'='leverage_delegate' AND p->>'programId'=p_program AND p->'idl'->>'canonicalSha256'=p_idl)
    OR p_key IS DISTINCT FROM concat_ws('|',p_cluster,p_program,p_idl,p_revision,p_signature,array_to_string(p_path,'.'))
    OR EXISTS(SELECT 1 FROM unnest(p_path) n WHERE n<0 OR n>65535)
    OR p_order IS DISTINCT FROM p_payload::jsonb->'accounts'->'named'->>'order'
    OR p_owner IS DISTINCT FROM COALESCE(p_payload::jsonb->'accounts'->'named'->>'owner',p_payload::jsonb->'accounts'->'named'->>'order_owner')
    OR p_market IS DISTINCT FROM p_payload::jsonb->'accounts'->'named'->>'market' THEN
    RAISE EXCEPTION 'FINALIZED_INVARIANT: invalid order instruction identity';
  END IF;
  -- Streamed rows carry arrival time, which differs on redelivery. The same
  -- instruction under its key keeps its first row and time; only a changed
  -- instruction is new evidence.
  IF NOT EXISTS(SELECT 1 FROM dusk_ingestion.order_instruction_observations
    WHERE (cluster,program_id,idl_hash,protocol_revision,instruction_key)=(p_cluster,p_program,p_idl,p_revision,p_key)
      AND (slot,blockhash,instruction_path,instruction_name,order_address,owner_address,market_address,raw_instruction,payload)
        IS NOT DISTINCT FROM (p_slot,p_block,p_path,p_name,p_order,p_owner,p_market,p_raw,p_payload::jsonb)) THEN
    digest := encode(sha256(convert_to(jsonb_build_array(p_slot,p_block,p_time,p_path,p_name,p_order,p_owner,p_market,encode(p_raw,'base64'),p_payload::jsonb)::text,'UTF8')),'hex');
    INSERT INTO dusk_ingestion.order_instruction_observations(cluster,program_id,idl_hash,protocol_revision,instruction_key,signature,slot,blockhash,block_time,instruction_path,instruction_name,order_address,owner_address,market_address,raw_instruction,payload,evidence_sha256)
    VALUES(p_cluster,p_program,p_idl,p_revision,p_key,p_signature,p_slot,p_block,to_timestamp(p_time),p_path,p_name,p_order,p_owner,p_market,p_raw,p_payload::jsonb,digest)
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NOT EXISTS(SELECT 1 FROM dusk_ingestion.order_instruction_observations
    WHERE (cluster,program_id,idl_hash,protocol_revision,instruction_key)=(p_cluster,p_program,p_idl,p_revision,p_key)
      AND (slot,blockhash,instruction_path,instruction_name,order_address,owner_address,market_address,raw_instruction,payload)
        IS DISTINCT FROM (p_slot,p_block,p_path,p_name,p_order,p_owner,p_market,p_raw,p_payload::jsonb));
END $$;

CREATE OR REPLACE FUNCTION dusk_ingestion.check_market_activity_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM dusk_ingestion.canonical_events c
    JOIN dusk_ingestion.event_observations o USING(cluster,program_id,idl_hash,protocol_revision,event_key,observation_id)
    WHERE (c.cluster,c.program_id,c.idl_hash,c.protocol_revision,c.event_key,c.observation_id)=
      (NEW.cluster,NEW.program_id,NEW.idl_hash,NEW.protocol_revision,NEW.event_key,NEW.observation_id)
      AND c.commitment IN ('confirmed','finalized') AND o.commitment=c.commitment AND o.event_name=NEW.event_name
      AND o.transaction_signature=NEW.signature AND o.slot=NEW.slot AND o.blockhash=NEW.blockhash
      AND o.decoded_payload=NEW.payload AND NEW.market=NEW.payload->>'market')
    OR (SELECT count(*) FROM dusk_ingestion.event_stream s WHERE
      (s.cluster,s.program_id,s.idl_hash,s.protocol_revision,s.event_key)=
      (NEW.cluster,NEW.program_id,NEW.idl_hash,NEW.protocol_revision,NEW.event_key))<>1
    OR NOT EXISTS (SELECT 1 FROM dusk_ingestion.event_stream s WHERE
      (s.cluster,s.program_id,s.idl_hash,s.protocol_revision,s.event_key)=
      (NEW.cluster,NEW.program_id,NEW.idl_hash,NEW.protocol_revision,NEW.event_key)
      AND s.time=NEW.block_time AND s.slot=NEW.slot AND s.transaction_signature=NEW.signature
      AND s.event_name=NEW.event_name AND s.market=NEW.market AND s.payload=NEW.payload) THEN
    RAISE EXCEPTION 'FINALIZED_INVARIANT: native market activity lacks its exact canonical event-time source';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION dusk_ingestion.check_yield_claim_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT count(*) FROM dusk_ingestion.canonical_events c
    JOIN dusk_ingestion.event_observations o USING(cluster,program_id,idl_hash,protocol_revision,event_key,observation_id)
    JOIN dusk_ingestion.event_stream s USING(cluster,program_id,idl_hash,protocol_revision,event_key)
    WHERE (c.cluster,c.program_id,c.idl_hash,c.protocol_revision,c.event_key,c.observation_id)=
      (NEW.cluster,NEW.program_id,NEW.idl_hash,NEW.protocol_revision,NEW.event_key,NEW.observation_id)
      AND c.commitment IN ('confirmed','finalized') AND o.commitment=c.commitment
      AND o.event_name='YieldClaimed' AND s.event_name=o.event_name
      AND s.transaction_signature=o.transaction_signature AND s.slot=o.slot AND s.payload=o.decoded_payload
      AND s.time=NEW.block_time AND o.transaction_signature=NEW.signature
      AND o.slot=NEW.slot AND o.blockhash=NEW.blockhash AND o.decoded_payload=NEW.payload
      AND NEW.payload @> jsonb_build_object('owner',NEW.owner,'market',NEW.market,'lp_mint',NEW.lp_mint,
        'asset_mint',NEW.asset_mint,'recipient',NEW.recipient,'token_kind',NEW.token_kind::text,
        'swap_fee_amount',NEW.swap_fee_amount::text,'interest_amount',NEW.interest_amount::text,
        'recipient_credit',NEW.recipient_credit::text)) <> 1 THEN
    RAISE EXCEPTION 'FINALIZED_INVARIANT: yield claim does not match its canonical event';
  END IF;
  RETURN NEW;
END $$;

-- Read-path indexes cover confirmed rows too.
DROP INDEX dusk_ingestion.dusk_finalized_yield_claim_sources;
CREATE INDEX dusk_yield_claim_sources ON dusk_ingestion.event_observations
  (cluster,program_id,idl_hash,protocol_revision,slot,event_key)
  WHERE commitment IN ('confirmed','finalized') AND event_name='YieldClaimed';
DROP INDEX dusk_ingestion.dusk_history_actor_page;
CREATE INDEX dusk_history_actor_page ON dusk_ingestion.event_observations
  (cluster,program_id,idl_hash,protocol_revision,
   dusk_ingestion.event_history_actor(event_name,decoded_payload),slot DESC,event_key DESC)
  WHERE commitment IN ('confirmed','finalized');
DROP INDEX dusk_ingestion.dusk_history_liquidator_page;
CREATE INDEX dusk_history_liquidator_page ON dusk_ingestion.event_observations
  (cluster,program_id,idl_hash,protocol_revision,(decoded_payload->>'liquidator'),slot DESC,event_key DESC)
  WHERE commitment IN ('confirmed','finalized') AND event_name IN ('BorrowPositionLiquidated','LeveragePositionLiquidated')
    AND dusk_ingestion.event_history_actor(event_name,decoded_payload) IS DISTINCT FROM decoded_payload->>'liquidator';
DROP INDEX dusk_ingestion.dusk_history_market_page;
CREATE INDEX dusk_history_market_page ON dusk_ingestion.event_observations
  (cluster,program_id,idl_hash,protocol_revision,(decoded_payload->>'market'),slot DESC,event_key DESC)
  WHERE commitment IN ('confirmed','finalized');
DROP INDEX dusk_ingestion.dusk_history_page;
CREATE INDEX dusk_history_page ON dusk_ingestion.event_observations
  (cluster,program_id,idl_hash,protocol_revision,slot DESC,event_key DESC)
  WHERE commitment IN ('confirmed','finalized');
COMMIT;
