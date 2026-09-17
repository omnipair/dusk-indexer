-- Bind event ingestion to the attested program release. Historical identities
-- keep their original rows; registration never relabels existing observations.
BEGIN;

CREATE TABLE dusk_ingestion.deployment_intervals (
    cluster TEXT NOT NULL,
    protocol_revision TEXT NOT NULL,
    pin_sha256 TEXT NOT NULL CHECK (pin_sha256 ~ '^[0-9a-f]{64}$'),
    pin JSONB NOT NULL,
    first_slot BIGINT NOT NULL CHECK (first_slot > 0),
    verified_through_slot BIGINT NOT NULL CHECK (verified_through_slot >= first_slot),
    registered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cluster,protocol_revision)
);

CREATE FUNCTION dusk_ingestion.protect_deployment_interval() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP='DELETE' THEN
        RAISE EXCEPTION 'FINALIZED_INVARIANT: deployment intervals are immutable';
    END IF;
    IF (NEW.cluster,NEW.protocol_revision,NEW.pin_sha256,NEW.pin,NEW.first_slot,NEW.registered_at)
       IS DISTINCT FROM
       (OLD.cluster,OLD.protocol_revision,OLD.pin_sha256,OLD.pin,OLD.first_slot,OLD.registered_at)
       OR NEW.verified_through_slot < OLD.verified_through_slot THEN
        RAISE EXCEPTION 'FINALIZED_INVARIANT: deployment identity or interval regressed';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER protect_deployment_interval BEFORE UPDATE OR DELETE
ON dusk_ingestion.deployment_intervals FOR EACH ROW
EXECUTE FUNCTION dusk_ingestion.protect_deployment_interval();

CREATE FUNCTION dusk_ingestion.record_deployment_interval(
    p_cluster TEXT,p_revision TEXT,p_first BIGINT,p_through BIGINT,p_sha TEXT,p_pin_text TEXT
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
    body JSONB := p_pin_text::jsonb;
    existing dusk_ingestion.deployment_intervals%ROWTYPE;
    derived_first BIGINT;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended('dusk-deployment|'||p_cluster||'|'||p_revision,0));
    SELECT max((program->'deployment'->>'deploySlot')::bigint)+1 INTO derived_first
      FROM jsonb_array_elements(body->'programs') program;
    IF body->>'revision' IS DISTINCT FROM p_revision
       OR body->'cluster'->>'name' IS DISTINCT FROM p_cluster
       OR body->'cluster'->>'genesisHash' IS DISTINCT FROM 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'
       OR p_cluster<>'devnet' OR COALESCE(jsonb_array_length(body->'programs'),0)<>2
       OR derived_first IS DISTINCT FROM p_first OR p_through<p_first
       OR encode(sha256(convert_to(p_pin_text,'UTF8')),'hex') IS DISTINCT FROM p_sha THEN
        RAISE EXCEPTION 'FINALIZED_INVARIANT: invalid deployment interval registration';
    END IF;
    IF (SELECT count(DISTINCT p->>'programId') FROM jsonb_array_elements(body->'programs') p)<>2
       OR (SELECT count(DISTINCT p->>'name') FROM jsonb_array_elements(body->'programs') p WHERE p->>'name' IN ('dusk','leverage_delegate'))<>2
       OR EXISTS (SELECT 1 FROM jsonb_array_elements(body->'programs') p WHERE
         COALESCE(p->>'programId','') !~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
         OR COALESCE(p->'idl'->>'canonicalSha256','') !~ '^[0-9a-f]{64}$'
         OR COALESCE(p->'binary'->>'sha256','') !~ '^[0-9a-f]{64}$'
         OR COALESCE(p->'deployment'->>'programData','') !~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
         OR COALESCE((p->'deployment'->>'deploySlot')::bigint,0)<=0
         OR COALESCE((p->'deployment'->>'allocatedBinaryBytes')::bigint,0) NOT BETWEEN 4 AND 16777216
         OR NOT COALESCE(p->'deployment' ? 'upgradeAuthority',false)
         OR (p->'deployment'->'upgradeAuthority'<>'null'::jsonb AND COALESCE(p->'deployment'->>'upgradeAuthority','') !~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$')) THEN
        RAISE EXCEPTION 'FINALIZED_INVARIANT: incomplete deployed program metadata';
    END IF;
    SELECT * INTO existing FROM dusk_ingestion.deployment_intervals
      WHERE cluster=p_cluster AND protocol_revision=p_revision FOR UPDATE;
    IF FOUND AND (existing.pin_sha256<>p_sha OR existing.pin<>body OR existing.first_slot<>p_first) THEN
        RAISE EXCEPTION 'FINALIZED_INVARIANT: revision reused for another deployment';
    END IF;
    IF NOT FOUND THEN
        -- Registration fails on contaminated current-revision data. Repair must
        -- preserve its original evidence and be an explicit migration/replay.
        IF EXISTS (SELECT 1 FROM dusk_ingestion.event_observations e
          WHERE e.cluster=p_cluster AND e.protocol_revision=p_revision
          AND (e.slot<p_first OR e.slot>p_through OR NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(body->'programs') p
            WHERE p->>'programId'=e.program_id AND p->'idl'->>'canonicalSha256'=e.idl_hash)))
          OR EXISTS (SELECT 1 FROM dusk_ingestion.ingestion_cursors c
            WHERE c.cluster=p_cluster AND c.protocol_revision=p_revision
            AND (c.next_slot<p_first OR c.last_observed_slot<p_first OR c.last_observed_slot>p_through)) THEN
            RAISE EXCEPTION 'FINALIZED_INVARIANT: existing history is outside its deployment interval';
        END IF;
    END IF;
    INSERT INTO dusk_ingestion.deployment_intervals
      (cluster,protocol_revision,pin_sha256,pin,first_slot,verified_through_slot)
    VALUES (p_cluster,p_revision,p_sha,body,p_first,p_through)
    ON CONFLICT (cluster,protocol_revision) DO UPDATE SET
      verified_through_slot=GREATEST(dusk_ingestion.deployment_intervals.verified_through_slot,EXCLUDED.verified_through_slot),
      updated_at=now();
END $$;

CREATE FUNCTION dusk_ingestion.guard_deployment_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE deployment dusk_ingestion.deployment_intervals%ROWTYPE;
BEGIN
    PERFORM pg_advisory_xact_lock_shared(hashtextextended('dusk-deployment|'||NEW.cluster||'|'||NEW.protocol_revision,0));
    SELECT * INTO deployment FROM dusk_ingestion.deployment_intervals
      WHERE cluster=NEW.cluster AND protocol_revision=NEW.protocol_revision;
    IF FOUND AND (NEW.slot<deployment.first_slot OR NEW.slot>deployment.verified_through_slot
      OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(deployment.pin->'programs') p
        WHERE p->>'programId'=NEW.program_id AND p->'idl'->>'canonicalSha256'=NEW.idl_hash)) THEN
        RAISE EXCEPTION 'FINALIZED_INVARIANT: event is outside its deployment identity or interval';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER guard_deployment_event BEFORE INSERT OR UPDATE
ON dusk_ingestion.event_observations FOR EACH ROW EXECUTE FUNCTION dusk_ingestion.guard_deployment_event();

CREATE FUNCTION dusk_ingestion.guard_deployment_cursor() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE deployment dusk_ingestion.deployment_intervals%ROWTYPE;
BEGIN
    PERFORM pg_advisory_xact_lock_shared(hashtextextended('dusk-deployment|'||NEW.cluster||'|'||NEW.protocol_revision,0));
    SELECT * INTO deployment FROM dusk_ingestion.deployment_intervals
      WHERE cluster=NEW.cluster AND protocol_revision=NEW.protocol_revision;
    IF FOUND AND (NEW.next_slot<deployment.first_slot OR NEW.last_observed_slot<deployment.first_slot
      OR NEW.last_observed_slot>deployment.verified_through_slot
      OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(deployment.pin->'programs') p
        WHERE p->>'programId'=NEW.program_id AND p->'idl'->>'canonicalSha256'=NEW.idl_hash)) THEN
        RAISE EXCEPTION 'FINALIZED_INVARIANT: cursor is outside its deployment identity or interval';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER guard_deployment_cursor BEFORE INSERT OR UPDATE
ON dusk_ingestion.ingestion_cursors FOR EACH ROW EXECUTE FUNCTION dusk_ingestion.guard_deployment_cursor();
COMMIT;
