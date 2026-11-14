-- Permit mainnet with its exact genesis while preserving immutable deployment identities.
CREATE OR REPLACE FUNCTION dusk_ingestion.record_deployment_interval(
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
       OR NOT COALESCE(
         (p_cluster='devnet' AND body->'cluster'->>'genesisHash'='EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG')
         OR (p_cluster='mainnet-beta' AND body->'cluster'->>'genesisHash'='5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'),false)
       OR COALESCE(jsonb_array_length(body->'programs'),0)<>2
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
