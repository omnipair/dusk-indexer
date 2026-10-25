BEGIN;

-- Protocol revision v6 keeps the direct yLP proposal path and adds reusable
-- governance balances. Both paths emit the same proposal lifecycle events;
-- reusable support mutations use GovernanceSupportChanged.
CREATE OR REPLACE VIEW dusk_ingestion.streamed_governance_proposals AS
WITH created AS (
  SELECT DISTINCT ON (cluster,program_id,idl_hash,protocol_revision,payload->>'proposal')
    cluster,program_id,idl_hash,protocol_revision,payload->>'proposal' AS proposal,payload,slot AS created_slot
  FROM dusk_ingestion.streamed_events WHERE event_name='ParameterProposalCreated'
  ORDER BY cluster,program_id,idl_hash,protocol_revision,payload->>'proposal',slot,observation_id
), lifecycle AS (
  SELECT DISTINCT ON (cluster,program_id,idl_hash,protocol_revision,payload->>'proposal')
    cluster,program_id,idl_hash,protocol_revision,payload->>'proposal' AS proposal,slot AS last_slot,
    CASE event_name WHEN 'ParameterProposalQueued' THEN 1 WHEN 'ParameterProposalExecuted' THEN 2
      ELSE (payload->>'status')::int END AS status
  FROM dusk_ingestion.streamed_events
  WHERE event_name IN ('ParameterProposalCreated','ParameterProposalSupported','ParameterProposalSupportWithdrawn',
    'GovernanceSupportChanged','ParameterProposalQueued','ParameterProposalExecuted')
  ORDER BY cluster,program_id,idl_hash,protocol_revision,payload->>'proposal',slot DESC,observation_id DESC
), locked AS (
  SELECT DISTINCT ON (cluster,program_id,idl_hash,protocol_revision,payload->>'proposal')
    cluster,program_id,idl_hash,protocol_revision,payload->>'proposal' AS proposal,payload->>'total_locked' AS total_locked
  FROM dusk_ingestion.streamed_events
  WHERE event_name IN ('ParameterProposalSupported','ParameterProposalSupportWithdrawn','GovernanceSupportChanged','ParameterProposalQueued')
  ORDER BY cluster,program_id,idl_hash,protocol_revision,payload->>'proposal',slot DESC,observation_id DESC
), queued AS (
  SELECT DISTINCT ON (cluster,program_id,idl_hash,protocol_revision,payload->>'proposal')
    cluster,program_id,idl_hash,protocol_revision,payload->>'proposal' AS proposal,payload
  FROM dusk_ingestion.streamed_events WHERE event_name='ParameterProposalQueued'
  ORDER BY cluster,program_id,idl_hash,protocol_revision,payload->>'proposal',slot DESC,observation_id DESC
), executed AS (
  SELECT DISTINCT ON (cluster,program_id,idl_hash,protocol_revision,payload->>'proposal')
    cluster,program_id,idl_hash,protocol_revision,payload->>'proposal' AS proposal,payload
  FROM dusk_ingestion.streamed_events WHERE event_name='ParameterProposalExecuted'
  ORDER BY cluster,program_id,idl_hash,protocol_revision,payload->>'proposal',slot DESC,observation_id DESC
)
SELECT c.cluster,c.program_id,c.idl_hash,c.protocol_revision,c.proposal,c.payload->>'market' AS market,
  c.payload AS created,COALESCE(l.total_locked,c.payload->>'initial_support') AS total_locked,s.status,
  q.payload->>'eligible_supply' AS eligible_supply_at_queue,q.payload->>'total_locked' AS queued_support,
  (q.payload->>'queued_at')::bigint AS queued_at,
  (q.payload->>'execute_after')::bigint AS execute_after,(q.payload->>'execution_deadline')::bigint AS execution_deadline,
  (e.payload->>'executed_at')::bigint AS executed_at,c.created_slot,s.last_slot
FROM created c
JOIN lifecycle s USING(cluster,program_id,idl_hash,protocol_revision,proposal)
LEFT JOIN locked l USING(cluster,program_id,idl_hash,protocol_revision,proposal)
LEFT JOIN queued q USING(cluster,program_id,idl_hash,protocol_revision,proposal)
LEFT JOIN executed e USING(cluster,program_id,idl_hash,protocol_revision,proposal);

CREATE OR REPLACE VIEW dusk_ingestion.streamed_governance_supports AS
WITH changes AS (
  SELECT cluster,program_id,idl_hash,protocol_revision,payload->>'proposal' AS proposal,
    payload->>'supporter' AS supporter,
    CASE event_name WHEN 'ParameterProposalSupported' THEN (payload->>'amount')::numeric
      ELSE -(payload->>'amount')::numeric END AS delta,slot
  FROM dusk_ingestion.streamed_events
  WHERE event_name IN ('ParameterProposalSupported','ParameterProposalSupportWithdrawn')
  UNION ALL
  SELECT cluster,program_id,idl_hash,protocol_revision,payload->>'proposal' AS proposal,
    payload->>'owner' AS supporter,
    CASE WHEN (payload->>'withdrawn')::boolean THEN -(payload->>'amount')::numeric
      ELSE (payload->>'amount')::numeric END AS delta,slot
  FROM dusk_ingestion.streamed_events
  WHERE event_name='GovernanceSupportChanged'
)
SELECT cluster,program_id,idl_hash,protocol_revision,proposal,supporter,
  sum(delta) AS locked_amount,max(slot) AS last_slot
FROM changes
GROUP BY cluster,program_id,idl_hash,protocol_revision,proposal,supporter;

COMMIT;
