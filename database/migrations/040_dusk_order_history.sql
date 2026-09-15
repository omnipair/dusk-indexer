-- Order state is transient; successful finalized instructions are durable evidence.
BEGIN;
CREATE TABLE dusk_ingestion.order_instruction_observations (
  observation_id BIGSERIAL PRIMARY KEY,
  cluster TEXT NOT NULL, program_id TEXT NOT NULL, idl_hash TEXT NOT NULL, protocol_revision TEXT NOT NULL,
  instruction_key TEXT NOT NULL, signature TEXT NOT NULL CHECK(signature ~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$'),
  slot BIGINT NOT NULL CHECK(slot>0), blockhash TEXT NOT NULL,
  block_time TIMESTAMPTZ NOT NULL, instruction_path INTEGER[] NOT NULL CHECK(cardinality(instruction_path)>0),
  instruction_name TEXT NOT NULL, order_address TEXT NOT NULL, owner_address TEXT NOT NULL, market_address TEXT,
  raw_instruction BYTEA NOT NULL, payload JSONB NOT NULL,
  evidence_sha256 TEXT NOT NULL CHECK(evidence_sha256 ~ '^[0-9a-f]{64}$'),
  observed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(cluster,program_id,idl_hash,protocol_revision,instruction_key,evidence_sha256),
  FOREIGN KEY(cluster,program_id,idl_hash,protocol_revision) REFERENCES dusk_ingestion.protocol_identities(cluster,program_id,idl_hash,protocol_revision)
);
CREATE INDEX order_history_owner ON dusk_ingestion.order_instruction_observations(cluster,program_id,idl_hash,protocol_revision,owner_address,slot DESC,instruction_key DESC);
CREATE INDEX order_history_address ON dusk_ingestion.order_instruction_observations(cluster,program_id,idl_hash,protocol_revision,order_address);
CREATE TABLE dusk_ingestion.order_history_scans (LIKE dusk_ingestion.history_scans INCLUDING ALL);
ALTER TABLE dusk_ingestion.order_history_scans ADD FOREIGN KEY(cluster,program_id,idl_hash,protocol_revision) REFERENCES dusk_ingestion.protocol_identities(cluster,program_id,idl_hash,protocol_revision);

CREATE FUNCTION dusk_ingestion.immutable_order_observation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'FINALIZED_INVARIANT: order observations are immutable'; END $$;
CREATE TRIGGER immutable_order_observation BEFORE UPDATE OR DELETE ON dusk_ingestion.order_instruction_observations FOR EACH ROW EXECUTE FUNCTION dusk_ingestion.immutable_order_observation();

CREATE FUNCTION dusk_ingestion.record_order_instruction(
  p_cluster TEXT,p_program TEXT,p_idl TEXT,p_revision TEXT,p_key TEXT,p_signature TEXT,p_slot BIGINT,p_block TEXT,p_time BIGINT,p_path INTEGER[],
  p_name TEXT,p_order TEXT,p_owner TEXT,p_market TEXT,p_raw BYTEA,p_payload TEXT
) RETURNS BOOLEAN LANGUAGE plpgsql AS $$
DECLARE deployment dusk_ingestion.deployment_intervals%ROWTYPE; digest TEXT;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('dusk-order-history|'||p_cluster||'|'||p_revision,0));
  SELECT * INTO deployment FROM dusk_ingestion.deployment_intervals WHERE cluster=p_cluster AND protocol_revision=p_revision;
  IF NOT FOUND OR p_slot NOT BETWEEN deployment.first_slot AND deployment.verified_through_slot
    OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(deployment.pin->'programs') p WHERE p->>'name'='leverage_delegate' AND p->>'programId'=p_program AND p->'idl'->>'canonicalSha256'=p_idl)
    OR p_key IS DISTINCT FROM concat_ws('|',p_cluster,p_program,p_idl,p_revision,p_signature,array_to_string(p_path,'.'))
    OR EXISTS(SELECT 1 FROM unnest(p_path) n WHERE n<0 OR n>65535)
    OR p_order IS DISTINCT FROM p_payload::jsonb->'accounts'->'named'->>'order'
    OR p_owner IS DISTINCT FROM COALESCE(p_payload::jsonb->'accounts'->'named'->>'owner',p_payload::jsonb->'accounts'->'named'->>'order_owner')
    OR p_market IS DISTINCT FROM p_payload::jsonb->'accounts'->'named'->>'market' THEN
    RAISE EXCEPTION 'FINALIZED_INVARIANT: invalid order instruction identity';
  END IF;
  digest := encode(sha256(convert_to(jsonb_build_array(p_slot,p_block,p_time,p_path,p_name,p_order,p_owner,p_market,encode(p_raw,'base64'),p_payload::jsonb)::text,'UTF8')),'hex');
  INSERT INTO dusk_ingestion.order_instruction_observations(cluster,program_id,idl_hash,protocol_revision,instruction_key,signature,slot,blockhash,block_time,instruction_path,instruction_name,order_address,owner_address,market_address,raw_instruction,payload,evidence_sha256)
  VALUES(p_cluster,p_program,p_idl,p_revision,p_key,p_signature,p_slot,p_block,to_timestamp(p_time),p_path,p_name,p_order,p_owner,p_market,p_raw,p_payload::jsonb,digest)
  ON CONFLICT DO NOTHING;
  RETURN NOT EXISTS(SELECT 1 FROM dusk_ingestion.order_instruction_observations WHERE (cluster,program_id,idl_hash,protocol_revision,instruction_key)=(p_cluster,p_program,p_idl,p_revision,p_key) AND evidence_sha256<>digest)
    AND NOT EXISTS(SELECT 1 FROM dusk_ingestion.order_history_scans s WHERE s.cluster=p_cluster AND s.program_id=p_program AND s.idl_hash=p_idl AND s.protocol_revision=p_revision AND p_slot BETWEEN s.from_slot AND s.through_slot
      AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(s.transactions) r WHERE r->>'signature'=p_signature AND (r->>'slot')::bigint=p_slot AND r->>'blockhash'=p_block AND r->'instructionKeys' ? p_key));
END $$;

CREATE FUNCTION dusk_ingestion.guard_order_history_scan() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE deployment dusk_ingestion.deployment_intervals%ROWTYPE; previous dusk_ingestion.order_history_scans%ROWTYPE; receipt JSONB; actual_keys JSONB;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'FINALIZED_INVARIANT: order scans are immutable'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('dusk-order-history|'||NEW.cluster||'|'||NEW.protocol_revision,0));
  SELECT * INTO deployment FROM dusk_ingestion.deployment_intervals WHERE cluster=NEW.cluster AND protocol_revision=NEW.protocol_revision;
  IF NOT FOUND OR NEW.from_slot<deployment.first_slot OR NEW.through_slot>deployment.verified_through_slot
    OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(deployment.pin->'programs') p WHERE p->>'name'='leverage_delegate' AND p->>'programId'=NEW.program_id AND p->'idl'->>'canonicalSha256'=NEW.idl_hash) THEN
    RAISE EXCEPTION 'FINALIZED_INVARIANT: order scan outside deployed identity';
  END IF;
  SELECT * INTO previous FROM dusk_ingestion.order_history_scans WHERE (cluster,program_id,idl_hash,protocol_revision)=(NEW.cluster,NEW.program_id,NEW.idl_hash,NEW.protocol_revision) ORDER BY through_slot DESC LIMIT 1;
  IF NEW.from_slot IS DISTINCT FROM COALESCE(previous.through_slot+1,deployment.first_slot)
    OR previous.release_block_time IS NOT NULL AND NEW.release_block_time<>previous.release_block_time
    OR NEW.through_block_time<COALESCE(previous.through_block_time,NEW.release_block_time) OR NEW.through_block_time>NEW.completed_at THEN
    RAISE EXCEPTION 'FINALIZED_INVARIANT: order scan skipped or regressed boundary';
  END IF;
  IF EXISTS(SELECT 1 FROM dusk_ingestion.order_instruction_observations WHERE cluster=NEW.cluster AND program_id=NEW.program_id AND idl_hash=NEW.idl_hash AND protocol_revision=NEW.protocol_revision GROUP BY instruction_key HAVING count(DISTINCT evidence_sha256)>1) THEN
    RAISE EXCEPTION 'FINALIZED_INVARIANT: contradictory order observations';
  END IF;
  IF (SELECT count(DISTINCT r->>'signature') FROM jsonb_array_elements(NEW.transactions) r)<>jsonb_array_length(NEW.transactions) THEN RAISE EXCEPTION 'FINALIZED_INVARIANT: duplicate order receipt'; END IF;
  FOR receipt IN SELECT value FROM jsonb_array_elements(NEW.transactions) LOOP
    IF COALESCE(receipt->>'signature','') !~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$'
      OR COALESCE((receipt->>'slot')::bigint,-1) NOT BETWEEN NEW.from_slot AND NEW.through_slot
      OR COALESCE(receipt->>'blockhash','') !~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
      OR COALESCE(receipt->>'transactionSha256','') !~ '^[0-9a-f]{64}$'
      OR jsonb_typeof(receipt->'failed') IS DISTINCT FROM 'boolean'
      OR jsonb_typeof(receipt->'instructionKeys') IS DISTINCT FROM 'array'
      OR (receipt->>'failed')::boolean AND jsonb_array_length(receipt->'instructionKeys')<>0 THEN
      RAISE EXCEPTION 'FINALIZED_INVARIANT: invalid order scan receipt';
    END IF;
    SELECT COALESCE(jsonb_agg(instruction_key ORDER BY instruction_key),'[]'::jsonb) INTO actual_keys FROM dusk_ingestion.order_instruction_observations
      WHERE cluster=NEW.cluster AND program_id=NEW.program_id AND idl_hash=NEW.idl_hash AND protocol_revision=NEW.protocol_revision
      AND signature=receipt->>'signature' AND slot=(receipt->>'slot')::bigint AND blockhash=receipt->>'blockhash';
    IF actual_keys IS DISTINCT FROM receipt->'instructionKeys' THEN RAISE EXCEPTION 'FINALIZED_INVARIANT: order scan precedes observation persistence'; END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM dusk_ingestion.order_instruction_observations o WHERE o.cluster=NEW.cluster AND o.program_id=NEW.program_id AND o.idl_hash=NEW.idl_hash AND o.protocol_revision=NEW.protocol_revision AND o.slot BETWEEN NEW.from_slot AND NEW.through_slot
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.transactions) r WHERE r->>'signature'=o.signature AND (r->>'slot')::bigint=o.slot AND r->>'blockhash'=o.blockhash AND r->'instructionKeys' ? o.instruction_key)) THEN
    RAISE EXCEPTION 'FINALIZED_INVARIANT: order scan omitted known instruction';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_order_history_scan BEFORE INSERT OR UPDATE OR DELETE ON dusk_ingestion.order_history_scans FOR EACH ROW EXECUTE FUNCTION dusk_ingestion.guard_order_history_scan();
COMMIT;
