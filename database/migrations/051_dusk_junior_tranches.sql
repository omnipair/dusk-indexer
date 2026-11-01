BEGIN;
-- Junior cohorts are separate Token-2022 mints. Never merge generations:
-- after a wipe, old receipts retain historical income rights but no principal.

CREATE OR REPLACE VIEW dusk_ingestion.streamed_lp_mints AS
SELECT cluster,program_id,idl_hash,protocol_revision,market,mint AS lp_mint,kind
FROM dusk_ingestion.streamed_markets
CROSS JOIN LATERAL (VALUES (ylp_mint,'ylp'),(base_hlp_mint,'base_hlp'),(quote_hlp_mint,'quote_hlp')) AS m(mint,kind)
UNION
SELECT cluster,program_id,idl_hash,protocol_revision,payload->>'market',payload->>'new_mint',
  CASE payload->>'target_asset' WHEN '0' THEN 'base_hlp' ELSE 'quote_hlp' END
FROM dusk_ingestion.streamed_events WHERE event_name='HlpCohortRotated'
UNION
SELECT cluster,program_id,idl_hash,protocol_revision,payload->>'market',payload->>'mint','junior'
FROM dusk_ingestion.streamed_events WHERE event_name='JuniorCohortInitialized';

CREATE OR REPLACE VIEW dusk_ingestion.streamed_lp_movements AS
SELECT e.cluster,e.program_id,e.idl_hash,e.protocol_revision,m.market,m.ylp_mint AS lp_mint,'ylp' AS kind,
  e.payload->>'owner' AS owner,
  CASE e.event_name WHEN 'LiquidityAdded' THEN 1 ELSE -1 END*(e.payload->>'ylp_amount')::numeric AS delta,e.slot,e.observation_id
FROM dusk_ingestion.streamed_events e
JOIN dusk_ingestion.streamed_markets m ON (m.cluster,m.program_id,m.idl_hash,m.protocol_revision,m.market)=
  (e.cluster,e.program_id,e.idl_hash,e.protocol_revision,e.payload->>'market')
WHERE e.event_name IN ('LiquidityAdded','LiquidityRemoved')
UNION ALL
SELECT e.cluster,e.program_id,e.idl_hash,e.protocol_revision,m.market,
  COALESCE((SELECT r.payload->>'new_mint' FROM dusk_ingestion.streamed_events r
    WHERE (r.cluster,r.program_id,r.idl_hash,r.protocol_revision,r.payload->>'market')=
      (e.cluster,e.program_id,e.idl_hash,e.protocol_revision,e.payload->>'market')
      AND r.event_name='HlpCohortRotated' AND r.payload->>'target_asset'=e.payload->>'asset_side'
      AND (r.slot,r.observation_id)<=(e.slot,e.observation_id)
    ORDER BY r.slot DESC,r.observation_id DESC LIMIT 1),
    CASE e.payload->>'asset_side' WHEN '0' THEN m.base_hlp_mint ELSE m.quote_hlp_mint END),
  CASE e.payload->>'asset_side' WHEN '0' THEN 'base_hlp' ELSE 'quote_hlp' END,
  e.payload->>'owner',CASE e.event_name WHEN 'HlpOpened' THEN 1 ELSE -1 END*(e.payload->>'hlp_amount')::numeric,
  e.slot,e.observation_id
FROM dusk_ingestion.streamed_events e
JOIN dusk_ingestion.streamed_markets m ON (m.cluster,m.program_id,m.idl_hash,m.protocol_revision,m.market)=
  (e.cluster,e.program_id,e.idl_hash,e.protocol_revision,e.payload->>'market')
WHERE e.event_name IN ('HlpOpened','HlpClosed')
UNION ALL
SELECT e.cluster,e.program_id,e.idl_hash,e.protocol_revision,l.market,l.lp_mint,l.kind,t.owner,t.delta,e.slot,e.observation_id
FROM dusk_ingestion.streamed_events e
JOIN dusk_ingestion.streamed_lp_mints l ON (l.cluster,l.program_id,l.idl_hash,l.protocol_revision,l.lp_mint)=
  (e.cluster,e.program_id,e.idl_hash,e.protocol_revision,e.payload->>'lp_mint')
CROSS JOIN LATERAL (VALUES (e.payload->>'source_owner',-(e.payload->>'amount')::numeric),
  (e.payload->>'destination_owner',(e.payload->>'amount')::numeric)) AS t(owner,delta)
WHERE e.event_name='LpTransferred'
UNION ALL
SELECT e.cluster,e.program_id,e.idl_hash,e.protocol_revision,e.payload->>'market',e.payload->>'mint',l.kind,
  e.payload->>'owner',-(e.payload->>'amount')::numeric,e.slot,e.observation_id
FROM dusk_ingestion.streamed_events e
JOIN dusk_ingestion.streamed_lp_mints l ON (l.cluster,l.program_id,l.idl_hash,l.protocol_revision,l.lp_mint)=
  (e.cluster,e.program_id,e.idl_hash,e.protocol_revision,e.payload->>'mint')
WHERE e.event_name='HlpRetiredReceiptBurned'
UNION ALL
-- Converting into junior burns senior receipts; executing an exit mints them.
SELECT e.cluster,e.program_id,e.idl_hash,e.protocol_revision,e.payload->>'market',m.ylp_mint,'ylp',
  e.payload->>'owner',CASE e.payload->>'action' WHEN '0' THEN -(e.payload->>'senior_amount')::numeric
    ELSE (e.payload->>'senior_amount')::numeric END,e.slot,e.observation_id
FROM dusk_ingestion.streamed_events e
JOIN dusk_ingestion.streamed_markets m ON (m.cluster,m.program_id,m.idl_hash,m.protocol_revision,m.market)=
  (e.cluster,e.program_id,e.idl_hash,e.protocol_revision,e.payload->>'market')
WHERE e.event_name='TrancheConverted' AND e.payload->>'action' IN ('0','2')
UNION ALL
-- Requests burn active jrLP into escrow; cancellation remints the net ticket.
SELECT e.cluster,e.program_id,e.idl_hash,e.protocol_revision,e.payload->>'market',c.payload->>'mint','junior',
  e.payload->>'owner',CASE e.payload->>'action' WHEN '1' THEN -(e.payload->>'junior_amount')::numeric
    ELSE (e.payload->>'junior_amount')::numeric END,e.slot,e.observation_id
FROM dusk_ingestion.streamed_events e
JOIN LATERAL (
  SELECT i.payload FROM dusk_ingestion.streamed_events i
  WHERE (i.cluster,i.program_id,i.idl_hash,i.protocol_revision,i.payload->>'market')=
    (e.cluster,e.program_id,e.idl_hash,e.protocol_revision,e.payload->>'market')
    AND i.event_name='JuniorCohortInitialized'
    AND (i.slot,i.observation_id)<=(e.slot,e.observation_id)
  ORDER BY i.slot DESC,i.observation_id DESC LIMIT 1
) c ON true
WHERE e.event_name='TrancheConverted' AND e.payload->>'action' IN ('0','1','3')
UNION ALL
SELECT e.cluster,e.program_id,e.idl_hash,e.protocol_revision,e.payload->>'market',e.payload->>'mint','junior',
  e.payload->>'owner',-(e.payload->>'wallet_amount')::numeric,e.slot,e.observation_id
FROM dusk_ingestion.streamed_events e WHERE e.event_name='RetiredJuniorBurned';

CREATE OR REPLACE VIEW dusk_ingestion.streamed_lp_balances AS
SELECT cluster,program_id,idl_hash,protocol_revision,market,lp_mint,kind,owner,
  sum(delta) AS amount,max(slot) AS last_slot
FROM dusk_ingestion.streamed_lp_movements
GROUP BY cluster,program_id,idl_hash,protocol_revision,market,lp_mint,kind,owner;

-- One row per owner/cohort with its current burned jrLP exit escrow. A request
-- addition pays its fee immediately; convert/cancel terminates that cycle.
CREATE VIEW dusk_ingestion.streamed_junior_exits AS
WITH events AS (
  SELECT e.*,c.payload->>'mint' AS junior_mint,
    count(*) FILTER (WHERE e.payload->>'action' IN ('2','3')) OVER (
      PARTITION BY e.cluster,e.program_id,e.idl_hash,e.protocol_revision,e.payload->>'market',e.payload->>'owner',c.payload->>'mint'
      ORDER BY e.slot,e.observation_id) AS cycle
  FROM dusk_ingestion.streamed_events e
  JOIN LATERAL (
    SELECT i.payload FROM dusk_ingestion.streamed_events i
    WHERE (i.cluster,i.program_id,i.idl_hash,i.protocol_revision,i.payload->>'market')=
      (e.cluster,e.program_id,e.idl_hash,e.protocol_revision,e.payload->>'market')
      AND i.event_name='JuniorCohortInitialized'
      AND (i.slot,i.observation_id)<=(e.slot,e.observation_id)
    ORDER BY i.slot DESC,i.observation_id DESC LIMIT 1
  ) c ON true
  WHERE e.event_name='TrancheConverted'
), current_cycle AS (
  SELECT DISTINCT ON (cluster,program_id,idl_hash,protocol_revision,payload->>'market',payload->>'owner',junior_mint)
    cluster,program_id,idl_hash,protocol_revision,payload->>'market' AS market,payload->>'owner' AS owner,
    junior_mint,cycle
  FROM events ORDER BY cluster,program_id,idl_hash,protocol_revision,payload->>'market',payload->>'owner',junior_mint,
    slot DESC,observation_id DESC
), requests AS (
  SELECT e.cluster,e.program_id,e.idl_hash,e.protocol_revision,e.payload->>'market' AS market,
    e.payload->>'owner' AS owner,e.junior_mint,e.cycle,
    sum((e.payload->>'junior_amount')::numeric-(e.payload->>'junior_fee')::numeric) AS receipts,
    max(e.slot) AS last_slot,
    (array_agg(e.payload->>'ready_at' ORDER BY e.slot DESC,e.observation_id DESC))[1] AS ready_at,
    (array_agg(e.payload->>'expires_at' ORDER BY e.slot DESC,e.observation_id DESC))[1] AS expires_at
  FROM events e WHERE e.payload->>'action'='1'
  GROUP BY e.cluster,e.program_id,e.idl_hash,e.protocol_revision,e.payload->>'market',e.payload->>'owner',e.junior_mint,e.cycle
)
SELECT r.cluster,r.program_id,r.idl_hash,r.protocol_revision,r.market,r.owner,r.junior_mint,
  r.receipts,r.ready_at::numeric AS ready_at,r.expires_at::numeric AS expires_at,r.last_slot
FROM requests r JOIN current_cycle c USING(cluster,program_id,idl_hash,protocol_revision,market,owner,junior_mint,cycle)
WHERE r.receipts>0;

COMMIT;
