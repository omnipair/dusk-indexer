-- Dusk ingestion foundation.
--
-- This schema is intentionally separate from the legacy Omnipair V2 tables.
-- It stores immutable chain observations first; product projections are rebuilt
-- from canonical observations and are not defined by this migration.

BEGIN;

CREATE SCHEMA IF NOT EXISTS dusk_ingestion;

CREATE TABLE dusk_ingestion.protocol_identities (
    cluster TEXT NOT NULL,
    program_id TEXT NOT NULL,
    idl_hash TEXT NOT NULL CHECK (idl_hash ~ '^[0-9a-f]{64}$'),
    protocol_revision TEXT NOT NULL,
    activated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    retired_at TIMESTAMPTZ,
    PRIMARY KEY (cluster, program_id, idl_hash, protocol_revision),
    CHECK (cluster <> ''),
    CHECK (program_id <> ''),
    CHECK (protocol_revision <> ''),
    CHECK (retired_at IS NULL OR retired_at >= activated_at)
);

CREATE TABLE dusk_ingestion.ingestion_cursors (
    cluster TEXT NOT NULL,
    program_id TEXT NOT NULL,
    idl_hash TEXT NOT NULL,
    protocol_revision TEXT NOT NULL,
    stream_name TEXT NOT NULL,
    commitment TEXT NOT NULL CHECK (commitment IN ('processed', 'confirmed', 'finalized')),
    next_slot BIGINT NOT NULL CHECK (next_slot >= 0),
    last_observed_slot BIGINT CHECK (last_observed_slot >= 0),
    last_finalized_slot BIGINT CHECK (last_finalized_slot >= 0),
    last_signature TEXT,
    last_blockhash TEXT,
    generation BIGINT NOT NULL DEFAULT 0 CHECK (generation >= 0),
    lease_owner TEXT,
    lease_expires_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cluster, program_id, idl_hash, protocol_revision, stream_name),
    FOREIGN KEY (cluster, program_id, idl_hash, protocol_revision)
        REFERENCES dusk_ingestion.protocol_identities
            (cluster, program_id, idl_hash, protocol_revision),
    CHECK (last_observed_slot IS NULL OR last_observed_slot < next_slot),
    CHECK (last_finalized_slot IS NULL OR last_observed_slot IS NULL OR last_finalized_slot <= last_observed_slot)
);

CREATE TABLE dusk_ingestion.event_observations (
    observation_id BIGSERIAL PRIMARY KEY,
    cluster TEXT NOT NULL,
    program_id TEXT NOT NULL,
    idl_hash TEXT NOT NULL,
    protocol_revision TEXT NOT NULL,
    event_key TEXT NOT NULL,
    transaction_signature TEXT NOT NULL,
    instruction_path INTEGER[] NOT NULL,
    event_ordinal INTEGER NOT NULL CHECK (event_ordinal BETWEEN 0 AND 65535),
    slot BIGINT NOT NULL CHECK (slot >= 0),
    blockhash TEXT NOT NULL,
    parent_slot BIGINT CHECK (parent_slot >= 0),
    commitment TEXT NOT NULL CHECK (commitment IN ('processed', 'confirmed', 'finalized')),
    event_name TEXT,
    payload_hash TEXT NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
    decoded_payload JSONB,
    raw_event BYTEA,
    source TEXT NOT NULL,
    observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    FOREIGN KEY (cluster, program_id, idl_hash, protocol_revision)
        REFERENCES dusk_ingestion.protocol_identities
            (cluster, program_id, idl_hash, protocol_revision),
    UNIQUE (cluster, program_id, idl_hash, protocol_revision, event_key, blockhash),
    UNIQUE (cluster, program_id, idl_hash, protocol_revision, event_key, observation_id),
    CHECK (cardinality(instruction_path) > 0),
    CHECK (blockhash <> ''),
    CHECK (source <> '')
);

CREATE INDEX dusk_event_observations_slot_idx
    ON dusk_ingestion.event_observations
        (cluster, program_id, idl_hash, protocol_revision, slot);

CREATE INDEX dusk_event_observations_signature_idx
    ON dusk_ingestion.event_observations
        (cluster, program_id, transaction_signature);

CREATE TABLE dusk_ingestion.canonical_events (
    cluster TEXT NOT NULL,
    program_id TEXT NOT NULL,
    idl_hash TEXT NOT NULL,
    protocol_revision TEXT NOT NULL,
    event_key TEXT NOT NULL,
    observation_id BIGINT NOT NULL,
    commitment TEXT NOT NULL CHECK (commitment IN ('processed', 'confirmed', 'finalized')),
    canonical_since TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cluster, program_id, idl_hash, protocol_revision, event_key),
    FOREIGN KEY (cluster, program_id, idl_hash, protocol_revision, event_key, observation_id)
        REFERENCES dusk_ingestion.event_observations
            (cluster, program_id, idl_hash, protocol_revision, event_key, observation_id)
);

CREATE TABLE dusk_ingestion.rollback_runs (
    rollback_id BIGSERIAL PRIMARY KEY,
    cluster TEXT NOT NULL,
    program_id TEXT NOT NULL,
    idl_hash TEXT NOT NULL,
    protocol_revision TEXT NOT NULL,
    detected_slot BIGINT NOT NULL CHECK (detected_slot >= 0),
    common_ancestor_slot BIGINT CHECK (common_ancestor_slot >= 0),
    reason TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('planned', 'running', 'completed', 'failed')),
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ,
    error JSONB,
    FOREIGN KEY (cluster, program_id, idl_hash, protocol_revision)
        REFERENCES dusk_ingestion.protocol_identities
            (cluster, program_id, idl_hash, protocol_revision),
    CHECK (completed_at IS NULL OR completed_at >= started_at)
);

CREATE TABLE dusk_ingestion.rollback_entries (
    rollback_id BIGINT NOT NULL REFERENCES dusk_ingestion.rollback_runs(rollback_id),
    event_key TEXT NOT NULL,
    orphaned_observation_id BIGINT NOT NULL REFERENCES dusk_ingestion.event_observations(observation_id),
    replacement_observation_id BIGINT REFERENCES dusk_ingestion.event_observations(observation_id),
    action TEXT NOT NULL CHECK (action IN ('orphan', 'replace', 'restore')),
    applied_at TIMESTAMPTZ,
    PRIMARY KEY (rollback_id, event_key)
);

CREATE TABLE dusk_ingestion.backfill_ranges (
    backfill_id BIGSERIAL PRIMARY KEY,
    cluster TEXT NOT NULL,
    program_id TEXT NOT NULL,
    idl_hash TEXT NOT NULL,
    protocol_revision TEXT NOT NULL,
    from_slot BIGINT NOT NULL CHECK (from_slot >= 0),
    to_slot BIGINT NOT NULL CHECK (to_slot >= 0),
    next_slot BIGINT NOT NULL CHECK (next_slot >= 0),
    commitment TEXT NOT NULL CHECK (commitment IN ('confirmed', 'finalized')),
    status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed', 'superseded')),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    lease_owner TEXT,
    lease_expires_at TIMESTAMPTZ,
    last_error JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    FOREIGN KEY (cluster, program_id, idl_hash, protocol_revision)
        REFERENCES dusk_ingestion.protocol_identities
            (cluster, program_id, idl_hash, protocol_revision),
    CHECK (from_slot <= next_slot AND next_slot <= to_slot + 1),
    UNIQUE (cluster, program_id, idl_hash, protocol_revision, from_slot, to_slot)
);

CREATE TABLE dusk_ingestion.reconciliation_runs (
    reconciliation_id BIGSERIAL PRIMARY KEY,
    cluster TEXT NOT NULL,
    program_id TEXT NOT NULL,
    idl_hash TEXT NOT NULL,
    protocol_revision TEXT NOT NULL,
    from_slot BIGINT NOT NULL CHECK (from_slot >= 0),
    to_slot BIGINT NOT NULL CHECK (to_slot >= 0),
    commitment TEXT NOT NULL CHECK (commitment IN ('confirmed', 'finalized')),
    status TEXT NOT NULL CHECK (status IN ('running', 'matched', 'mismatch', 'failed')),
    expected_observations BIGINT CHECK (expected_observations >= 0),
    actual_observations BIGINT CHECK (actual_observations >= 0),
    expected_digest TEXT CHECK (expected_digest IS NULL OR expected_digest ~ '^[0-9a-f]{64}$'),
    actual_digest TEXT CHECK (actual_digest IS NULL OR actual_digest ~ '^[0-9a-f]{64}$'),
    mismatch_details JSONB,
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ,
    FOREIGN KEY (cluster, program_id, idl_hash, protocol_revision)
        REFERENCES dusk_ingestion.protocol_identities
            (cluster, program_id, idl_hash, protocol_revision),
    CHECK (from_slot <= to_slot),
    CHECK (completed_at IS NULL OR completed_at >= started_at)
);

CREATE OR REPLACE FUNCTION dusk_ingestion.protect_finalized_canonical_event()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD.commitment = 'finalized' AND NEW.observation_id <> OLD.observation_id THEN
        RAISE EXCEPTION 'cannot replace finalized canonical event %', OLD.event_key;
    END IF;
    IF NEW.commitment = 'processed' AND OLD.commitment IN ('confirmed', 'finalized') THEN
        RAISE EXCEPTION 'cannot downgrade canonical event commitment %', OLD.event_key;
    END IF;
    IF NEW.commitment = 'confirmed' AND OLD.commitment = 'finalized' THEN
        RAISE EXCEPTION 'cannot downgrade finalized canonical event %', OLD.event_key;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER dusk_protect_finalized_canonical_event
BEFORE UPDATE ON dusk_ingestion.canonical_events
FOR EACH ROW EXECUTE FUNCTION dusk_ingestion.protect_finalized_canonical_event();

COMMIT;
