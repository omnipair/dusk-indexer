BEGIN;
CREATE TABLE keeper_wallet_budget (
  work_key text NOT NULL REFERENCES keeper_flash_work(work_key),
  wallet text NOT NULL,
  asset text NOT NULL,
  maximum numeric(20,0) NOT NULL CHECK (maximum >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (work_key, asset)
);
CREATE INDEX keeper_wallet_budget_usage ON keeper_wallet_budget(wallet, asset, created_at);
COMMIT;
