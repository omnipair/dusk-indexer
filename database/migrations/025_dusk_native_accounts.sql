BEGIN;
CREATE TABLE IF NOT EXISTS dusk_ingestion.account_scans (
  scan_id BIGSERIAL PRIMARY KEY,
  cluster TEXT NOT NULL, program_id TEXT NOT NULL, idl_hash TEXT NOT NULL, protocol_revision TEXT NOT NULL,
  slot BIGINT NOT NULL CHECK (slot >= 0), blockhash TEXT NOT NULL, parent_slot BIGINT NOT NULL,
  content_hash TEXT NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  observed_at TIMESTAMPTZ NOT NULL DEFAULT now(), applied_at TIMESTAMPTZ,
  UNIQUE (cluster, program_id, idl_hash, protocol_revision, slot, blockhash),
  FOREIGN KEY (cluster, program_id, idl_hash, protocol_revision)
    REFERENCES dusk_ingestion.protocol_identities (cluster, program_id, idl_hash, protocol_revision)
);
CREATE TABLE IF NOT EXISTS dusk_ingestion.account_observations (
  scan_id BIGINT NOT NULL REFERENCES dusk_ingestion.account_scans(scan_id),
  account_pubkey TEXT NOT NULL,
  data_hash TEXT NOT NULL CHECK (data_hash ~ '^[0-9a-f]{64}$'),
  raw_account BYTEA NOT NULL,
  closed BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (scan_id, account_pubkey)
);
CREATE TABLE IF NOT EXISTS dusk_ingestion.account_projections (
  cluster TEXT NOT NULL, program_id TEXT NOT NULL, idl_hash TEXT NOT NULL, protocol_revision TEXT NOT NULL,
  account_pubkey TEXT NOT NULL, scan_id BIGINT NOT NULL,
  account_name TEXT, decoded_fields JSONB, projections JSONB NOT NULL DEFAULT '{}',
  closed BOOLEAN NOT NULL DEFAULT false,
  projection_version TEXT NOT NULL DEFAULT 'native-accounts.v1',
  PRIMARY KEY (cluster, program_id, idl_hash, protocol_revision, account_pubkey),
  FOREIGN KEY (scan_id, account_pubkey) REFERENCES dusk_ingestion.account_observations(scan_id, account_pubkey)
);
CREATE INDEX IF NOT EXISTS dusk_native_owner_idx ON dusk_ingestion.account_projections
  (cluster, program_id, idl_hash, protocol_revision, (decoded_fields->>'owner')) WHERE NOT closed;
CREATE INDEX IF NOT EXISTS dusk_native_market_idx ON dusk_ingestion.account_projections
  (cluster, program_id, idl_hash, protocol_revision, (decoded_fields->>'market')) WHERE NOT closed;

CREATE OR REPLACE VIEW dusk_ingestion.native_accounts AS
SELECT p.*, s.slot AS source_slot, s.blockhash, s.parent_slot, s.observed_at, 'finalized'::text AS commitment
FROM dusk_ingestion.account_projections p JOIN dusk_ingestion.account_scans s USING (scan_id)
WHERE s.applied_at IS NOT NULL;
CREATE OR REPLACE VIEW dusk_ingestion.native_markets AS
SELECT * FROM dusk_ingestion.native_accounts WHERE account_name = 'Market' AND NOT closed;
CREATE OR REPLACE VIEW dusk_ingestion.native_positions AS
SELECT *, decoded_fields->>'owner' AS owner, decoded_fields->>'market' AS market,
  decoded_fields->>'position_id' AS position_id
FROM dusk_ingestion.native_accounts
WHERE account_name IN ('BorrowPosition', 'LeveragePosition') AND NOT closed;
CREATE OR REPLACE VIEW dusk_ingestion.native_yield_accounts AS
SELECT *, decoded_fields->>'owner' AS owner, decoded_fields->>'market' AS market,
  decoded_fields->>'lp_mint' AS lp_mint, decoded_fields->>'asset_mint' AS asset_mint
FROM dusk_ingestion.native_accounts WHERE account_name = 'YieldAccount' AND NOT closed;

-- The complete RPC scan is applied atomically, including tombstones. A failed
-- or partial fetch never reaches this function and therefore cannot close rows.
CREATE OR REPLACE FUNCTION dusk_ingestion.apply_account_scan(target_scan BIGINT, decoded JSONB)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE batch dusk_ingestion.account_scans%ROWTYPE;
BEGIN
  SELECT * INTO STRICT batch FROM dusk_ingestion.account_scans WHERE scan_id = target_scan;
  PERFORM pg_advisory_xact_lock(hashtextextended(concat_ws('|', batch.cluster, batch.program_id, batch.idl_hash, batch.protocol_revision), 0));
  IF batch.applied_at IS NOT NULL THEN RETURN; END IF;
  IF EXISTS (SELECT 1 FROM dusk_ingestion.account_scans s WHERE
    (s.cluster,s.program_id,s.idl_hash,s.protocol_revision) = (batch.cluster,batch.program_id,batch.idl_hash,batch.protocol_revision)
    AND s.applied_at IS NOT NULL AND s.slot = batch.slot AND (s.content_hash <> batch.content_hash OR s.blockhash <> batch.blockhash OR s.parent_slot <> batch.parent_slot)) THEN
    RAISE EXCEPTION 'FINALIZED_INVARIANT: conflicting finalized account scan';
  END IF;
  -- Preserve observations from out-of-order replay without regressing current state.
  IF EXISTS (SELECT 1 FROM dusk_ingestion.account_scans s WHERE
    (s.cluster,s.program_id,s.idl_hash,s.protocol_revision) = (batch.cluster,batch.program_id,batch.idl_hash,batch.protocol_revision)
    AND s.applied_at IS NOT NULL AND s.slot > batch.slot) THEN RETURN; END IF;
  IF jsonb_array_length(decoded) <> (SELECT count(DISTINCT d->>'account') FROM jsonb_array_elements(decoded) d) THEN
    RAISE EXCEPTION 'FINALIZED_INVARIANT: duplicate decoded account';
  END IF;
  IF jsonb_array_length(decoded) <> (SELECT count(*) FROM dusk_ingestion.account_observations WHERE scan_id = target_scan AND NOT closed) THEN
    RAISE EXCEPTION 'FINALIZED_INVARIANT: incomplete decoded account scan';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(decoded) d LEFT JOIN dusk_ingestion.account_observations o
    ON o.scan_id = target_scan AND o.account_pubkey = d->>'account' WHERE o.account_pubkey IS NULL OR o.data_hash <> d->>'data_hash') THEN
    RAISE EXCEPTION 'FINALIZED_INVARIANT: projection does not match the captured account';
  END IF;
  INSERT INTO dusk_ingestion.account_observations (scan_id, account_pubkey, data_hash, raw_account, closed)
  SELECT target_scan, p.account_pubkey, repeat('0',64), ''::bytea, true
  FROM dusk_ingestion.account_projections p WHERE
    (p.cluster,p.program_id,p.idl_hash,p.protocol_revision) = (batch.cluster,batch.program_id,batch.idl_hash,batch.protocol_revision)
    AND NOT p.closed AND NOT EXISTS (SELECT 1 FROM dusk_ingestion.account_observations o WHERE o.scan_id = target_scan AND o.account_pubkey = p.account_pubkey)
  ON CONFLICT DO NOTHING;
  UPDATE dusk_ingestion.account_projections p SET closed = true, scan_id = target_scan
  FROM dusk_ingestion.account_observations o WHERE o.scan_id = target_scan AND o.closed AND o.account_pubkey = p.account_pubkey
    AND (p.cluster,p.program_id,p.idl_hash,p.protocol_revision) = (batch.cluster,batch.program_id,batch.idl_hash,batch.protocol_revision);
  INSERT INTO dusk_ingestion.account_projections (cluster, program_id, idl_hash, protocol_revision, account_pubkey, scan_id, account_name, decoded_fields, projections, closed)
  SELECT batch.cluster,batch.program_id,batch.idl_hash,batch.protocol_revision,d->>'account',target_scan,d->>'account_name',d->'fields',d->'projections',false
  FROM jsonb_array_elements(decoded) d
  ON CONFLICT (cluster,program_id,idl_hash,protocol_revision,account_pubkey) DO UPDATE SET
    scan_id=EXCLUDED.scan_id, account_name=EXCLUDED.account_name, decoded_fields=EXCLUDED.decoded_fields,
    projections=EXCLUDED.projections, closed=false;
  UPDATE dusk_ingestion.account_scans SET applied_at = now() WHERE scan_id = target_scan;
  PERFORM pg_notify('dusk_accounts_updated', json_build_object('cluster',batch.cluster,'programId',batch.program_id,'idlHash',batch.idl_hash,'protocolRevision',batch.protocol_revision,'slot',batch.slot)::text);
END $$;
COMMIT;
