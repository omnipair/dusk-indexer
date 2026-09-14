BEGIN;
CREATE TABLE dusk_ingestion.lp_token_scans (
  scan_id BIGSERIAL PRIMARY KEY,
  cluster TEXT NOT NULL, program_id TEXT NOT NULL, idl_hash TEXT NOT NULL, protocol_revision TEXT NOT NULL,
  market TEXT NOT NULL, lp_mint TEXT NOT NULL, token_kind TEXT NOT NULL CHECK (token_kind IN ('ylp','base_hlp','quote_hlp')),
  slot BIGINT NOT NULL CHECK (slot >= 0), blockhash TEXT NOT NULL, parent_slot BIGINT NOT NULL,
  block_time TIMESTAMPTZ NOT NULL, mint_slot BIGINT NOT NULL CHECK (mint_slot >= slot),
  mint_supply NUMERIC(20,0) NOT NULL CHECK (mint_supply >= 0), decimals SMALLINT NOT NULL CHECK (decimals BETWEEN 0 AND 255),
  raw_mint BYTEA NOT NULL, content_hash TEXT NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  account_count INTEGER NOT NULL CHECK (account_count >= 0), observed_at TIMESTAMPTZ NOT NULL DEFAULT now(), applied_at TIMESTAMPTZ,
  UNIQUE (cluster,program_id,idl_hash,protocol_revision,lp_mint,slot,blockhash),
  FOREIGN KEY (cluster,program_id,idl_hash,protocol_revision)
    REFERENCES dusk_ingestion.protocol_identities(cluster,program_id,idl_hash,protocol_revision)
);
CREATE TABLE dusk_ingestion.lp_token_observations (
  scan_id BIGINT NOT NULL REFERENCES dusk_ingestion.lp_token_scans(scan_id),
  token_account TEXT NOT NULL, owner TEXT NOT NULL,
  amount NUMERIC(20,0) NOT NULL CHECK (amount >= 0), frozen BOOLEAN NOT NULL, canonical_ata BOOLEAN NOT NULL,
  data_hash TEXT NOT NULL CHECK (data_hash ~ '^[0-9a-f]{64}$'), raw_account BYTEA NOT NULL,
  PRIMARY KEY (scan_id,token_account)
);
CREATE TRIGGER dusk_lp_observation_immutable BEFORE UPDATE OR DELETE ON dusk_ingestion.lp_token_observations
  FOR EACH ROW EXECUTE FUNCTION dusk_ingestion.reject_account_observation_mutation();

CREATE OR REPLACE FUNCTION dusk_ingestion.apply_lp_token_scan(target_scan BIGINT)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE batch dusk_ingestion.lp_token_scans%ROWTYPE;
BEGIN
  SELECT * INTO STRICT batch FROM dusk_ingestion.lp_token_scans WHERE scan_id = target_scan;
  PERFORM pg_advisory_xact_lock(hashtextextended(concat_ws('|', batch.cluster,batch.program_id,batch.idl_hash,batch.protocol_revision,batch.lp_mint),0));
  IF batch.applied_at IS NOT NULL THEN RETURN; END IF;
  IF EXISTS (SELECT 1 FROM dusk_ingestion.lp_token_scans s WHERE
    (s.cluster,s.program_id,s.idl_hash,s.protocol_revision,s.lp_mint,s.slot) =
    (batch.cluster,batch.program_id,batch.idl_hash,batch.protocol_revision,batch.lp_mint,batch.slot)
    AND s.applied_at IS NOT NULL AND (s.blockhash<>batch.blockhash OR s.parent_slot<>batch.parent_slot OR s.content_hash<>batch.content_hash)) THEN
    RAISE EXCEPTION 'FINALIZED_INVARIANT: contradictory LP ownership scan';
  END IF;
  IF batch.account_count <> (SELECT count(*) FROM dusk_ingestion.lp_token_observations WHERE scan_id=target_scan)
    OR batch.mint_supply <> (SELECT COALESCE(sum(amount),0) FROM dusk_ingestion.lp_token_observations WHERE scan_id=target_scan) THEN
    RAISE EXCEPTION 'FINALIZED_INVARIANT: incomplete LP ownership or inconsistent mint supply';
  END IF;
  UPDATE dusk_ingestion.lp_token_scans SET applied_at=now() WHERE scan_id=target_scan;
  PERFORM pg_notify('dusk_accounts_updated',json_build_object('cluster',batch.cluster,'programId',batch.program_id,
    'idlHash',batch.idl_hash,'protocolRevision',batch.protocol_revision,'slot',batch.slot)::text);
END $$;

-- Each row is a complete mint snapshot. Choosing the newest applied snapshot
-- automatically removes closed accounts and the prior owner after SetAuthority;
-- no deposit/withdraw delta can accidentally retain either balance.
CREATE VIEW dusk_ingestion.latest_lp_token_scans AS
SELECT DISTINCT ON (cluster,program_id,idl_hash,protocol_revision,lp_mint) *
FROM dusk_ingestion.lp_token_scans WHERE applied_at IS NOT NULL
ORDER BY cluster,program_id,idl_hash,protocol_revision,lp_mint,slot DESC,scan_id DESC;
CREATE VIEW dusk_ingestion.native_lp_ownership AS
SELECT s.cluster,s.program_id,s.idl_hash,s.protocol_revision,s.market,s.lp_mint,s.token_kind,
  s.slot AS source_slot,s.blockhash,s.block_time,s.observed_at,s.mint_slot,s.mint_supply,s.decimals,o.*
FROM dusk_ingestion.latest_lp_token_scans s JOIN dusk_ingestion.lp_token_observations o USING (scan_id);
CREATE INDEX dusk_lp_owner_lookup ON dusk_ingestion.lp_token_observations(owner,scan_id);
COMMIT;
