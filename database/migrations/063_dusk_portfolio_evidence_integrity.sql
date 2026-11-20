BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
-- Install/backfill atomically with respect to evidence inserts. Ordinary reads
-- continue; the source rows and their immutable constraints are unchanged.
LOCK TABLE dusk_ingestion.portfolio_account_evidence IN SHARE ROW EXCLUSIVE MODE;
CREATE TABLE dusk_ingestion.portfolio_evidence_banks (
  cluster TEXT NOT NULL, program_id TEXT NOT NULL, idl_hash TEXT NOT NULL, protocol_revision TEXT NOT NULL,
  account TEXT NOT NULL, slot BIGINT NOT NULL CHECK(slot>=0),
  basis TEXT NOT NULL CHECK(basis IN ('simulation-post-state','rpc-account')),
  blockhash TEXT NOT NULL, state_hash TEXT NOT NULL CHECK(state_hash ~ '^[0-9a-f]{64}$'),
  conflicted BOOLEAN NOT NULL,
  PRIMARY KEY(cluster,program_id,idl_hash,protocol_revision,account,slot,basis),
  FOREIGN KEY(cluster,program_id,idl_hash,protocol_revision)
    REFERENCES dusk_ingestion.protocol_identities(cluster,program_id,idl_hash,protocol_revision)
);
-- These fingerprints are comparison anchors only, never a fork winner or a
-- value used for pricing/payouts. Every original observation remains retained.
INSERT INTO dusk_ingestion.portfolio_evidence_banks
  (cluster,program_id,idl_hash,protocol_revision,account,slot,basis,blockhash,state_hash,conflicted)
SELECT cluster,program_id,idl_hash,protocol_revision,account,slot,basis,
  min(blockhash),min(state_hash),count(DISTINCT (blockhash,state_hash))>1
FROM dusk_ingestion.portfolio_account_evidence JOIN dusk_ingestion.portfolio_capture_observations USING(capture_id)
GROUP BY cluster,program_id,idl_hash,protocol_revision,account,slot,basis;
CREATE INDEX dusk_portfolio_conflicted_banks ON dusk_ingestion.portfolio_evidence_banks
  (cluster,program_id,idl_hash,protocol_revision) WHERE conflicted;

ANALYZE dusk_ingestion.portfolio_evidence_banks;

CREATE FUNCTION dusk_ingestion.protect_portfolio_evidence_bank() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('DELETE','TRUNCATE') THEN
    RAISE EXCEPTION 'FINALIZED_INVARIANT: portfolio evidence banks cannot be erased';
  END IF;
  IF (NEW.cluster,NEW.program_id,NEW.idl_hash,NEW.protocol_revision,NEW.account,NEW.slot,NEW.basis,NEW.blockhash,NEW.state_hash)
      IS DISTINCT FROM
     (OLD.cluster,OLD.program_id,OLD.idl_hash,OLD.protocol_revision,OLD.account,OLD.slot,OLD.basis,OLD.blockhash,OLD.state_hash)
     OR (OLD.conflicted AND NOT NEW.conflicted) THEN
    RAISE EXCEPTION 'FINALIZED_INVARIANT: portfolio evidence bank disagreement cannot be rewritten';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER dusk_portfolio_bank_immutable BEFORE UPDATE OR DELETE ON dusk_ingestion.portfolio_evidence_banks
  FOR EACH ROW EXECUTE FUNCTION dusk_ingestion.protect_portfolio_evidence_bank();
CREATE TRIGGER dusk_portfolio_bank_no_truncate BEFORE TRUNCATE ON dusk_ingestion.portfolio_evidence_banks
  FOR EACH STATEMENT EXECUTE FUNCTION dusk_ingestion.protect_portfolio_evidence_bank();

CREATE FUNCTION dusk_ingestion.index_portfolio_evidence_banks() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  -- One set-based update for the whole insert, including replay/import and
  -- ON CONFLICT batches. The unique bank key serializes concurrent writers;
  -- a disagreement is marked in the SAME transaction as its source evidence.
  -- A common lock order also avoids cycles between overlapping bank batches.
  INSERT INTO dusk_ingestion.portfolio_evidence_banks AS bank
    (cluster,program_id,idl_hash,protocol_revision,account,slot,basis,blockhash,state_hash,conflicted)
  SELECT o.cluster,o.program_id,o.idl_hash,o.protocol_revision,e.account,e.slot,e.basis,
    min(e.blockhash),min(e.state_hash),count(DISTINCT (e.blockhash,e.state_hash))>1
  FROM inserted_portfolio_evidence e JOIN dusk_ingestion.portfolio_capture_observations o USING(capture_id)
  GROUP BY o.cluster,o.program_id,o.idl_hash,o.protocol_revision,e.account,e.slot,e.basis
  ORDER BY o.cluster,o.program_id,o.idl_hash,o.protocol_revision,e.account,e.slot,e.basis
  ON CONFLICT(cluster,program_id,idl_hash,protocol_revision,account,slot,basis)
  DO UPDATE SET conflicted=true
    WHERE NOT bank.conflicted AND (EXCLUDED.conflicted
      OR bank.blockhash IS DISTINCT FROM EXCLUDED.blockhash OR bank.state_hash IS DISTINCT FROM EXCLUDED.state_hash);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION dusk_ingestion.index_portfolio_evidence_banks() FROM PUBLIC;
CREATE TRIGGER dusk_portfolio_evidence_bank_index AFTER INSERT ON dusk_ingestion.portfolio_account_evidence
  REFERENCING NEW TABLE AS inserted_portfolio_evidence FOR EACH STATEMENT
  EXECUTE FUNCTION dusk_ingestion.index_portfolio_evidence_banks();
COMMIT;
