-- Ephemeral display snapshots only. These never authorize a transaction and
-- never advance canonical history/ingestion cursors.
CREATE TABLE IF NOT EXISTS dusk_ingestion.live_snapshots (
  snapshot_key text PRIMARY KEY,
  deployment_identity_sha256 text NOT NULL CHECK (deployment_identity_sha256 ~ '^[0-9a-f]{64}$'),
  payload jsonb,
  refresh_after timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS live_snapshots_updated_at ON dusk_ingestion.live_snapshots(updated_at);
