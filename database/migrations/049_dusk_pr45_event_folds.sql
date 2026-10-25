BEGIN;
-- PR #45 replaces the legacy liquidation events, and hLP terminal recovery
-- can rotate the receipt mint. Keep every read projection on the canonical
-- event stream while following those new lifecycle events.

CREATE OR REPLACE VIEW dusk_ingestion.streamed_lp_mints AS
SELECT cluster,program_id,idl_hash,protocol_revision,market,mint AS lp_mint,kind
FROM dusk_ingestion.streamed_markets
CROSS JOIN LATERAL (VALUES (ylp_mint,'ylp'),(base_hlp_mint,'base_hlp'),(quote_hlp_mint,'quote_hlp')) AS m(mint,kind)
UNION
SELECT cluster,program_id,idl_hash,protocol_revision,payload->>'market',payload->>'new_mint',
  CASE payload->>'target_asset' WHEN '0' THEN 'base_hlp' ELSE 'quote_hlp' END
FROM dusk_ingestion.streamed_events WHERE event_name='HlpCohortRotated';

CREATE OR REPLACE VIEW dusk_ingestion.streamed_leverage_positions AS
WITH lifecycle AS (
  SELECT DISTINCT ON (cluster,program_id,idl_hash,protocol_revision,payload->>'position')
    cluster,program_id,idl_hash,protocol_revision,payload->>'position' AS position,event_name,slot,observation_id,time,
    CASE WHEN event_name IN ('FlashLiquidationSettled','EmergencyLiquidationSettled')
      THEN COALESCE((payload->'position_state'->>'closed')::boolean,false)
      ELSE event_name NOT IN ('LeveragePositionOpened','LeveragePositionUpdated') END AS closed
  FROM dusk_ingestion.streamed_events
  WHERE event_name IN ('LeveragePositionOpened','LeveragePositionUpdated','LeveragePositionClosed',
      'LeveragePositionLiquidated')
    OR (event_name='DebtFreePositionClosed' AND (payload->>'leverage')::boolean)
    OR (event_name IN ('FlashLiquidationSettled','EmergencyLiquidationSettled')
      AND (payload->>'leverage')::boolean)
  ORDER BY cluster,program_id,idl_hash,protocol_revision,payload->>'position',slot DESC,observation_id DESC
), identity AS (
  SELECT DISTINCT ON (cluster,program_id,idl_hash,protocol_revision,payload->>'position')
    cluster,program_id,idl_hash,protocol_revision,payload->>'position' AS position,payload
  FROM dusk_ingestion.streamed_events
  WHERE event_name IN ('LeveragePositionOpened','LeveragePositionUpdated')
  ORDER BY cluster,program_id,idl_hash,protocol_revision,payload->>'position',slot DESC,observation_id DESC
), liquidation AS (
  SELECT DISTINCT ON (cluster,program_id,idl_hash,protocol_revision,payload->>'position')
    cluster,program_id,idl_hash,protocol_revision,payload->>'position' AS position,payload,slot,observation_id
  FROM dusk_ingestion.streamed_events
  WHERE event_name IN ('FlashLiquidationSettled','EmergencyLiquidationSettled')
    AND (payload->>'leverage')::boolean
  ORDER BY cluster,program_id,idl_hash,protocol_revision,payload->>'position',slot DESC,observation_id DESC
)
SELECT l.cluster,l.program_id,l.idl_hash,l.protocol_revision,l.position,
  i.payload->>'market' AS market,i.payload->>'owner' AS owner,
  i.payload->>'debt_asset_mint' AS debt_asset_mint,i.payload->>'collateral_asset_mint' AS collateral_asset_mint,
  CASE WHEN (q.slot,q.observation_id)=(l.slot,l.observation_id)
    THEN (q.payload->'position_state'->>'leverage_collateral_amount')::numeric
    ELSE (i.payload->>'collateral_amount')::numeric END AS collateral_amount,
  CASE WHEN (q.slot,q.observation_id)=(l.slot,l.observation_id) THEN (q.payload->>'remaining_debt')::numeric
    ELSE (i.payload->>'debt_amount')::numeric END AS debt_amount,
  CASE WHEN (q.slot,q.observation_id)=(l.slot,l.observation_id)
    THEN (q.payload->'position_state'->>'leverage_debt_shares')::numeric
    ELSE (i.payload->>'debt_shares')::numeric END AS debt_shares,
  CASE WHEN (q.slot,q.observation_id)=(l.slot,l.observation_id)
    THEN 0 ELSE (i.payload->>'closeout_value')::numeric END AS closeout_value,
  NOT l.closed AS open,l.event_name AS last_event,l.slot AS last_slot,l.time AS last_time
FROM lifecycle l JOIN identity i USING(cluster,program_id,idl_hash,protocol_revision,position)
LEFT JOIN liquidation q USING(cluster,program_id,idl_hash,protocol_revision,position);

CREATE OR REPLACE VIEW dusk_ingestion.streamed_borrow_events AS
SELECT cluster,program_id,idl_hash,protocol_revision,
  COALESCE(payload->>'position',payload->>'borrow_position') AS position,
  COALESCE(payload->>'owner',payload->>'borrower',payload->'position_state'->>'owner') AS owner,
  payload->>'market' AS market,event_name,slot,observation_id,time,payload
FROM dusk_ingestion.streamed_events
WHERE event_name IN ('MarketCollateralDeposited','MarketCollateralWithdrawn','MarketDebtUpdated','BorrowPositionLiquidated',
    'LiquidationAuctionStarted','LiquidationAuctionCancelled')
  OR (event_name='DebtFreePositionClosed' AND NOT (payload->>'leverage')::boolean)
  OR (event_name IN ('FlashLiquidationSettled','EmergencyLiquidationSettled')
    AND NOT (payload->>'leverage')::boolean);

CREATE OR REPLACE VIEW dusk_ingestion.streamed_borrow_positions AS
WITH latest AS (
  SELECT DISTINCT ON (cluster,program_id,idl_hash,protocol_revision,position)
    cluster,program_id,idl_hash,protocol_revision,position,owner,market,event_name,slot,time,
    event_name='DebtFreePositionClosed'
      OR COALESCE((payload->>'closed')::boolean,(payload->'position_state'->>'closed')::boolean,false) AS closed
  FROM dusk_ingestion.streamed_borrow_events
  ORDER BY cluster,program_id,idl_hash,protocol_revision,position,slot DESC,observation_id DESC
), collateral AS (
  SELECT DISTINCT ON (cluster,program_id,idl_hash,protocol_revision,position)
    cluster,program_id,idl_hash,protocol_revision,position,
    CASE WHEN event_name IN ('FlashLiquidationSettled','EmergencyLiquidationSettled')
      THEN (payload->'position_state'->>'base_collateral')::numeric ELSE (payload->>'base_collateral')::numeric END AS base_collateral,
    CASE WHEN event_name IN ('FlashLiquidationSettled','EmergencyLiquidationSettled')
      THEN (payload->'position_state'->>'quote_collateral')::numeric ELSE (payload->>'quote_collateral')::numeric END AS quote_collateral
  FROM dusk_ingestion.streamed_borrow_events
  WHERE event_name IN ('MarketCollateralDeposited','MarketCollateralWithdrawn','BorrowPositionLiquidated',
    'FlashLiquidationSettled','EmergencyLiquidationSettled')
  ORDER BY cluster,program_id,idl_hash,protocol_revision,position,slot DESC,observation_id DESC
), shares AS (
  SELECT DISTINCT ON (cluster,program_id,idl_hash,protocol_revision,position)
    cluster,program_id,idl_hash,protocol_revision,position,
    CASE WHEN event_name IN ('FlashLiquidationSettled','EmergencyLiquidationSettled')
      THEN (payload->'position_state'->>'fixed_base_shares')::numeric ELSE (payload->>'fixed_base_shares')::numeric END AS fixed_base_shares,
    CASE WHEN event_name IN ('FlashLiquidationSettled','EmergencyLiquidationSettled')
      THEN (payload->'position_state'->>'fixed_quote_shares')::numeric ELSE (payload->>'fixed_quote_shares')::numeric END AS fixed_quote_shares
  FROM dusk_ingestion.streamed_borrow_events
  WHERE event_name IN ('MarketDebtUpdated','BorrowPositionLiquidated','FlashLiquidationSettled','EmergencyLiquidationSettled')
  ORDER BY cluster,program_id,idl_hash,protocol_revision,position,slot DESC,observation_id DESC
), health AS (
  SELECT DISTINCT ON (cluster,program_id,idl_hash,protocol_revision,position)
    cluster,program_id,idl_hash,protocol_revision,position,
    CASE WHEN event_name IN ('FlashLiquidationSettled','EmergencyLiquidationSettled')
      THEN (payload->'position_state'->>'global_health_base_contribution_for_quote_debt')::numeric
      ELSE (payload->>'global_health_base_contribution_for_quote_debt')::numeric END AS base_contribution_for_quote_debt,
    CASE WHEN event_name IN ('FlashLiquidationSettled','EmergencyLiquidationSettled')
      THEN (payload->'position_state'->>'global_health_quote_contribution_for_base_debt')::numeric
      ELSE (payload->>'global_health_quote_contribution_for_base_debt')::numeric END AS quote_contribution_for_base_debt,
    CASE WHEN event_name IN ('FlashLiquidationSettled','EmergencyLiquidationSettled')
      THEN (payload->'position_state'->>'base_liquidation_cf_bps')::int ELSE (payload->>'base_liquidation_cf_bps')::int END AS base_liquidation_cf_bps,
    CASE WHEN event_name IN ('FlashLiquidationSettled','EmergencyLiquidationSettled')
      THEN (payload->'position_state'->>'quote_liquidation_cf_bps')::int ELSE (payload->>'quote_liquidation_cf_bps')::int END AS quote_liquidation_cf_bps
  FROM dusk_ingestion.streamed_borrow_events
  WHERE event_name IN ('MarketCollateralDeposited','MarketCollateralWithdrawn','MarketDebtUpdated','BorrowPositionLiquidated',
    'FlashLiquidationSettled','EmergencyLiquidationSettled')
  ORDER BY cluster,program_id,idl_hash,protocol_revision,position,slot DESC,observation_id DESC
), auction AS (
  SELECT DISTINCT ON (cluster,program_id,idl_hash,protocol_revision,position)
    cluster,program_id,idl_hash,protocol_revision,position,
    CASE WHEN event_name IN ('LiquidationAuctionCancelled','FlashLiquidationSettled','EmergencyLiquidationSettled')
      THEN 255 ELSE (payload->>'auction_debt_asset')::int END AS auction_debt_asset
  FROM dusk_ingestion.streamed_borrow_events
  WHERE event_name IN ('MarketCollateralDeposited','MarketDebtUpdated','BorrowPositionLiquidated',
    'LiquidationAuctionStarted','LiquidationAuctionCancelled','FlashLiquidationSettled','EmergencyLiquidationSettled')
  ORDER BY cluster,program_id,idl_hash,protocol_revision,position,slot DESC,observation_id DESC
), started AS (
  SELECT DISTINCT ON (cluster,program_id,idl_hash,protocol_revision,position)
    cluster,program_id,idl_hash,protocol_revision,position,
    (payload->>'auction_start_time')::bigint AS auction_start_time,
    (payload->>'auction_start_price_nad')::numeric AS auction_start_price_nad,
    (payload->>'auction_floor_price_nad')::numeric AS auction_floor_price_nad
  FROM dusk_ingestion.streamed_borrow_events WHERE event_name='LiquidationAuctionStarted'
  ORDER BY cluster,program_id,idl_hash,protocol_revision,position,slot DESC,observation_id DESC
)
SELECT l.cluster,l.program_id,l.idl_hash,l.protocol_revision,l.position,l.market,l.owner,
  COALESCE(c.base_collateral,0) AS base_collateral,COALESCE(c.quote_collateral,0) AS quote_collateral,
  COALESCE(s.fixed_base_shares,0) AS fixed_base_shares,COALESCE(s.fixed_quote_shares,0) AS fixed_quote_shares,
  h.base_contribution_for_quote_debt,h.quote_contribution_for_base_debt,h.base_liquidation_cf_bps,h.quote_liquidation_cf_bps,
  COALESCE(a.auction_debt_asset,255) AS auction_debt_asset,
  CASE WHEN COALESCE(a.auction_debt_asset,255)<>255 THEN st.auction_start_time END AS auction_start_time,
  CASE WHEN COALESCE(a.auction_debt_asset,255)<>255 THEN st.auction_start_price_nad END AS auction_start_price_nad,
  CASE WHEN COALESCE(a.auction_debt_asset,255)<>255 THEN st.auction_floor_price_nad END AS auction_floor_price_nad,
  NOT l.closed AS open,l.event_name AS last_event,l.slot AS last_slot,l.time AS last_time
FROM latest l
LEFT JOIN collateral c USING(cluster,program_id,idl_hash,protocol_revision,position)
LEFT JOIN shares s USING(cluster,program_id,idl_hash,protocol_revision,position)
LEFT JOIN health h USING(cluster,program_id,idl_hash,protocol_revision,position)
LEFT JOIN auction a USING(cluster,program_id,idl_hash,protocol_revision,position)
LEFT JOIN started st USING(cluster,program_id,idl_hash,protocol_revision,position);

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
WHERE e.event_name='HlpRetiredReceiptBurned';

CREATE OR REPLACE FUNCTION dusk_ingestion.event_history_actor(name TEXT, payload JSONB)
RETURNS TEXT LANGUAGE SQL IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE name WHEN 'SwapExecuted' THEN payload->>'trader'
    WHEN 'BorrowPositionLiquidated' THEN payload->>'borrower'
    WHEN 'FlashLiquidationSettled' THEN payload->'position_state'->>'owner'
    WHEN 'EmergencyLiquidationSettled' THEN payload->>'owner'
    ELSE payload->>'owner' END
$$;

DROP INDEX IF EXISTS dusk_ingestion.dusk_history_liquidator_page;
CREATE INDEX dusk_history_liquidator_page ON dusk_ingestion.event_observations
  (cluster,program_id,idl_hash,protocol_revision,
    (COALESCE(decoded_payload->>'liquidator',decoded_payload->>'buyer',decoded_payload->>'caller')),slot DESC,event_key DESC)
  WHERE commitment IN ('confirmed','finalized')
    AND event_name IN ('BorrowPositionLiquidated','LeveragePositionLiquidated','FlashLiquidationSettled','EmergencyLiquidationSettled')
    AND dusk_ingestion.event_history_actor(event_name,decoded_payload) IS DISTINCT FROM
      COALESCE(decoded_payload->>'liquidator',decoded_payload->>'buyer',decoded_payload->>'caller');

ALTER TABLE dusk_ingestion.market_activity_events
  DROP CONSTRAINT IF EXISTS market_activity_events_event_name_check;
ALTER TABLE dusk_ingestion.market_activity_events ADD CONSTRAINT market_activity_events_event_name_check
  CHECK(event_name IN ('SwapExecuted','LeveragePositionOpened','LeveragePositionUpdated',
    'LeveragePositionClosed','LeveragePositionLiquidated','FlashLiquidationSettled',
    'EmergencyLiquidationSettled','MarketDebtUpdated','HlpClosed','HlpTerminalLiquidated'));

COMMIT;
