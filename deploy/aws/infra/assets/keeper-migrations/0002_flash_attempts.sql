BEGIN;
-- The transaction bytes are journaled before submission. A pending signature
-- blocks a replacement generation until finalized history resolves it.
CREATE TABLE keeper_flash_work (
  work_key text PRIMARY KEY, revision text NOT NULL, market text NOT NULL,
  position text NOT NULL, debt_asset smallint NOT NULL CHECK (debt_asset IN (0,1)),
  action text NOT NULL, observed_slot bigint NOT NULL, state_hash text NOT NULL,
  message bytea NOT NULL, blockhash text NOT NULL, last_valid_height bigint NOT NULL,
  signature text, transaction_bytes bytea, outcome text NOT NULL DEFAULT 'reserved',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX keeper_flash_pending_position ON keeper_flash_work (revision, position, debt_asset)
 WHERE outcome IN ('reserved','submitted_unknown');
CREATE TABLE keeper_flash_events (
  work_key text NOT NULL REFERENCES keeper_flash_work(work_key),
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  phase text NOT NULL, evidence jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
COMMIT;
