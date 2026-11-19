BEGIN;
-- Raw sealed finalized receipts precede their projections. This registry is
-- independent of live deployment intervals/cursors and cannot activate a pin.
CREATE TABLE dusk_ingestion.retirement_archives (
  cluster TEXT NOT NULL CHECK(cluster='mainnet-beta'),
  program_id TEXT NOT NULL CHECK(program_id='DuskWhswJYrzABDn8GqQD191X9RobRi5jhgGntXEdnKj'),
  idl_hash TEXT NOT NULL CHECK(idl_hash='2352edf3484da82f44408b556948647b9a05c8afa8efea815f6e63046286df52'),
  protocol_revision TEXT NOT NULL CHECK(protocol_revision='mainnet-retirement-aa196e3423fd'),
  archive_sha256 TEXT NOT NULL UNIQUE CHECK(archive_sha256 ~ '^[a-f0-9]{64}$'),
  market TEXT NOT NULL CHECK(market='7xf68VEvMtLJ2Up5zVZdA161uH1yNkTFYgDFhNUSwkM7'),
  helper_deploy_slot BIGINT NOT NULL CHECK(helper_deploy_slot>0),
  verified_through_slot BIGINT NOT NULL CHECK(verified_through_slot>helper_deploy_slot),
  archive JSONB NOT NULL,
  expected_events JSONB NOT NULL CHECK(jsonb_typeof(expected_events)='array' AND jsonb_array_length(expected_events)=15),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(cluster,program_id,idl_hash,protocol_revision),
  FOREIGN KEY(cluster,program_id,idl_hash,protocol_revision) REFERENCES dusk_ingestion.protocol_identities,
  CHECK((archive->>'schemaVersion'='dusk-retirement-receipt-archive.v2' AND archive->'localOnly'='false'::jsonb
    AND archive->>'contentSha256'=archive_sha256
    AND archive->>'sourceCommit'='aa196e3423fd5f46b00630a4f161d91f95ef7b3d'
    AND archive->'verified'->'completed'='true'::jsonb AND archive->'verified'->'masks'='[63,63]'::jsonb) IS TRUE)
);
-- Fresh RPC candidates are durable before comparison/projection, including
-- contradictory finalized responses which halt the operator without overwrites.
CREATE TABLE dusk_ingestion.retirement_rpc_observations (
 observation_id BIGSERIAL PRIMARY KEY,
 cluster TEXT NOT NULL,program_id TEXT NOT NULL,idl_hash TEXT NOT NULL,protocol_revision TEXT NOT NULL,
 archive_sha256 TEXT NOT NULL CHECK(archive_sha256 ~ '^[a-f0-9]{64}$'),
 kind TEXT NOT NULL CHECK(kind IN ('deployment','transaction','block')),request_key TEXT NOT NULL,
 payload_hash TEXT NOT NULL CHECK(payload_hash ~ '^[a-f0-9]{64}$'),payload JSONB NOT NULL,
 observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 FOREIGN KEY(cluster,program_id,idl_hash,protocol_revision) REFERENCES dusk_ingestion.protocol_identities,
 UNIQUE(cluster,program_id,idl_hash,protocol_revision,archive_sha256,kind,request_key,payload_hash)
);
CREATE FUNCTION dusk_ingestion.check_retirement_archive() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.archive->'protocolIdentity' IS DISTINCT FROM jsonb_build_object('cluster',NEW.cluster,'programId',NEW.program_id,
   'idlHash',NEW.idl_hash,'protocolRevision',NEW.protocol_revision,'genesisHash','5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d')
   OR (NEW.archive->'deployment'->>'deploySlot')::bigint IS DISTINCT FROM NEW.helper_deploy_slot
   OR (NEW.archive->>'verifiedThroughSlot')::bigint IS DISTINCT FROM NEW.verified_through_slot
   OR (SELECT count(DISTINCT x->>'eventKey') FROM jsonb_array_elements(NEW.expected_events) x)<>15
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.expected_events) x
     WHERE x->>'eventKey' IS NULL OR x->>'payloadHash' IS NULL OR x->>'payloadHash' !~ '^[a-f0-9]{64}$'
       OR x->>'slot' IS NULL OR (x->>'slot')::bigint<=NEW.helper_deploy_slot OR (x->>'slot')::bigint>NEW.verified_through_slot) THEN
   RAISE EXCEPTION 'FINALIZED_INVARIANT: retirement registration identity or expected events differ';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER dusk_retirement_archive_checked BEFORE INSERT ON dusk_ingestion.retirement_archives
 FOR EACH ROW EXECUTE FUNCTION dusk_ingestion.check_retirement_archive();
CREATE FUNCTION dusk_ingestion.immutable_retirement_archive() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'FINALIZED_INVARIANT: sealed retirement archives are immutable'; END $$;
CREATE TRIGGER dusk_retirement_archive_immutable BEFORE UPDATE OR DELETE ON dusk_ingestion.retirement_archives
  FOR EACH ROW EXECUTE FUNCTION dusk_ingestion.immutable_retirement_archive();

CREATE TRIGGER dusk_retirement_rpc_immutable BEFORE UPDATE OR DELETE ON dusk_ingestion.retirement_rpc_observations
 FOR EACH ROW EXECUTE FUNCTION dusk_ingestion.immutable_retirement_archive();

-- Only a fully reconciled set of exact finalized canonical observations can
-- yield a terminal withdrawal. Interrupted replay remains raw partial evidence.
CREATE VIEW dusk_ingestion.retirement_payouts AS
WITH reconciled AS (
 SELECT a.* FROM dusk_ingestion.retirement_archives a
 WHERE (SELECT count(*) FROM jsonb_array_elements(a.expected_events) x
  JOIN dusk_ingestion.canonical_events c ON (c.cluster,c.program_id,c.idl_hash,c.protocol_revision,c.event_key)=
    (a.cluster,a.program_id,a.idl_hash,a.protocol_revision,x->>'eventKey')
  JOIN dusk_ingestion.event_observations o USING(cluster,program_id,idl_hash,protocol_revision,event_key,observation_id)
  JOIN dusk_ingestion.event_stream s USING(cluster,program_id,idl_hash,protocol_revision,event_key)
  WHERE c.commitment='finalized' AND o.commitment='finalized' AND o.payload_hash=x->>'payloadHash'
    AND o.slot=(x->>'slot')::bigint AND o.slot>a.helper_deploy_slot AND o.slot<=a.verified_through_slot
    AND s.slot=o.slot AND s.payload=o.decoded_payload AND s.transaction_signature=o.transaction_signature AND s.event_name=o.event_name)=15
)
SELECT e.cluster,e.program_id,e.idl_hash,e.protocol_revision,e.event_key,e.signature,e.slot,e.time AS block_time,
  a.market,a.archive_sha256,e.payload->>'owner' AS owner,(e.payload->>'base')::numeric AS base_amount,
  (e.payload->>'quote')::numeric AS quote_amount,(e.payload->>'treasury')::boolean AS treasury,
  'omfgRBnxHsNJh6YeGbGAmWenNkenzsXyBXm3WDhmeta'::text AS base_mint,
  'METAwkXcqyXKy1AtsSgJ8JiUHwGCafnZL38n3vYmeta'::text AS quote_mint,6 AS asset_decimals,
  'dfd05743bca263f84193acbe882d281cb532806928fa357fc4ce0f07a4ec383c'::text AS legacy_idl_hash,
  'mainnet-2026-11-14'::text AS legacy_protocol_revision
FROM reconciled a JOIN dusk_ingestion.streamed_events e USING(cluster,program_id,idl_hash,protocol_revision)
JOIN LATERAL jsonb_array_elements(a.expected_events) x ON x->>'eventKey'=e.event_key AND x->>'payloadHash'=e.payload_hash
WHERE e.event_name='LegacyRetirementPaid';
COMMIT;
