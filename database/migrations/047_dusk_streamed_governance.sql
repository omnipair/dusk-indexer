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
  q.payload->>'eligible_supply' AS eligible_supply_at_queue,q.payload->>'total_locked' AS queued_support,
  (q.payload->>'queued_at')::bigint AS queued_at,
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

-- The latest swap snapshot per market.
CREATE VIEW dusk_ingestion.streamed_latest_market_snapshots AS
SELECT DISTINCT ON (cluster,program_id,idl_hash,protocol_revision,market)
  cluster,program_id,idl_hash,protocol_revision,market,event_key,observation_id,slot,time,signature,payload_hash,payload
FROM dusk_ingestion.streamed_market_snapshots
ORDER BY cluster,program_id,idl_hash,protocol_revision,market,slot DESC,observation_id DESC;

-- Each market's eligible direct yLP, folded from LP deltas: every yLP balance
-- except the two hLP yLP vaults, which the market PDA owns. Proposal support
-- burns yLP and a withdrawal mints it back, neither an LP movement, so
-- supporters' locked yLP stays counted, as the program's live supply plus
-- governance-locked minus vault yLP. Locked yLP sums the market's proposals.
CREATE VIEW dusk_ingestion.streamed_governance_markets AS
SELECT m.cluster,m.program_id,m.idl_hash,m.protocol_revision,m.market,
  COALESCE(b.eligible_ylp,0) AS eligible_ylp,COALESCE(p.governance_locked_ylp,0) AS governance_locked_ylp
FROM dusk_ingestion.streamed_markets m
LEFT JOIN (SELECT cluster,program_id,idl_hash,protocol_revision,market,sum(amount) AS eligible_ylp
  FROM dusk_ingestion.streamed_lp_balances WHERE kind='ylp' AND owner<>market
  GROUP BY cluster,program_id,idl_hash,protocol_revision,market) b USING(cluster,program_id,idl_hash,protocol_revision,market)
LEFT JOIN (SELECT cluster,program_id,idl_hash,protocol_revision,market,sum(total_locked::numeric) AS governance_locked_ylp
  FROM dusk_ingestion.streamed_governance_proposals
  GROUP BY cluster,program_id,idl_hash,protocol_revision,market) p USING(cluster,program_id,idl_hash,protocol_revision,market);
COMMIT;
