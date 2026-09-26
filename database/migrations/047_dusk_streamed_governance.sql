BEGIN;
-- Governance proposals from their streamed lifecycle events. Creation carries
-- the proposal's update and metadata; later events carry totals and status.

CREATE VIEW dusk_ingestion.streamed_governance_proposals AS
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
    'ParameterProposalQueued','ParameterProposalExecuted')
  ORDER BY cluster,program_id,idl_hash,protocol_revision,payload->>'proposal',slot DESC,observation_id DESC
), locked AS (
  SELECT DISTINCT ON (cluster,program_id,idl_hash,protocol_revision,payload->>'proposal')
    cluster,program_id,idl_hash,protocol_revision,payload->>'proposal' AS proposal,payload->>'total_locked' AS total_locked
  FROM dusk_ingestion.streamed_events
  WHERE event_name IN ('ParameterProposalSupported','ParameterProposalSupportWithdrawn','ParameterProposalQueued')
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
  q.payload->>'eligible_supply' AS eligible_supply_at_queue,(q.payload->>'queued_at')::bigint AS queued_at,
  (q.payload->>'execute_after')::bigint AS execute_after,(q.payload->>'execution_deadline')::bigint AS execution_deadline,
  (e.payload->>'executed_at')::bigint AS executed_at,c.created_slot,s.last_slot
FROM created c
JOIN lifecycle s USING(cluster,program_id,idl_hash,protocol_revision,proposal)
LEFT JOIN locked l USING(cluster,program_id,idl_hash,protocol_revision,proposal)
LEFT JOIN queued q USING(cluster,program_id,idl_hash,protocol_revision,proposal)
LEFT JOIN executed e USING(cluster,program_id,idl_hash,protocol_revision,proposal);

-- Each supporter's locked yLP per proposal.
CREATE VIEW dusk_ingestion.streamed_governance_supports AS
SELECT cluster,program_id,idl_hash,protocol_revision,payload->>'proposal' AS proposal,payload->>'supporter' AS supporter,
  sum(CASE event_name WHEN 'ParameterProposalSupported' THEN 1 ELSE -1 END*(payload->>'amount')::numeric) AS locked_amount,
  max(slot) AS last_slot
FROM dusk_ingestion.streamed_events
WHERE event_name IN ('ParameterProposalSupported','ParameterProposalSupportWithdrawn')
GROUP BY cluster,program_id,idl_hash,protocol_revision,payload->>'proposal',payload->>'supporter';

-- The latest crank observation per market.
CREATE VIEW dusk_ingestion.streamed_latest_market_observations AS
SELECT DISTINCT ON (cluster,program_id,idl_hash,protocol_revision,payload->>'market')
  cluster,program_id,idl_hash,protocol_revision,payload->>'market' AS market,slot,time,payload
FROM dusk_ingestion.streamed_events WHERE event_name='MarketObserved'
ORDER BY cluster,program_id,idl_hash,protocol_revision,payload->>'market',slot DESC,observation_id DESC;
COMMIT;
