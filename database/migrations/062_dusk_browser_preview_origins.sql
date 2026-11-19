-- Infrastructure metadata only; independent of protocol identities and canonical observations.
CREATE TABLE IF NOT EXISTS dusk_ingestion.browser_preview_events (
  event_id text PRIMARY KEY,body_sha256 text NOT NULL CHECK(body_sha256 ~ '^[a-f0-9]{64}$'),deployment_id text NOT NULL,
  event_type text NOT NULL,event_time_ms bigint NOT NULL,
  source text NOT NULL CHECK(source IN ('webhook','verified-api-bootstrap')),
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS dusk_ingestion.browser_preview_deployments (
  deployment_id text PRIMARY KEY,project_id text NOT NULL,team_id text NOT NULL,
  repository_id text NOT NULL,git_commit text NOT NULL,origins jsonb NOT NULL CHECK(jsonb_typeof(origins)='array'),
  created_event_ms bigint NOT NULL DEFAULT 0,ready_event_ms bigint NOT NULL DEFAULT 0,
  cleanup_event_ms bigint NOT NULL DEFAULT 0,updated_at timestamptz NOT NULL DEFAULT now()
);
