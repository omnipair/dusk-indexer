BEGIN;
-- Keep the original capture hash immutable. This attestation lets a later API
-- build recognize the same on-chain release without accepting unknown hashes.
CREATE TABLE dusk_ingestion.capture_deployments (
  cluster TEXT NOT NULL, program_id TEXT NOT NULL, idl_hash TEXT NOT NULL, protocol_revision TEXT NOT NULL,
  deployment_identity_sha256 TEXT PRIMARY KEY CHECK(deployment_identity_sha256 ~ '^[0-9a-f]{64}$'),
  envelope JSONB NOT NULL CHECK(jsonb_typeof(envelope)='object'
    AND envelope->>'deploymentIdentitySha256'=deployment_identity_sha256),
  registered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY(cluster,program_id,idl_hash,protocol_revision)
    REFERENCES dusk_ingestion.protocol_identities(cluster,program_id,idl_hash,protocol_revision)
);
CREATE TRIGGER dusk_capture_deployment_immutable BEFORE UPDATE OR DELETE ON dusk_ingestion.capture_deployments
  FOR EACH ROW EXECUTE FUNCTION dusk_ingestion.reject_account_observation_mutation();
COMMIT;
