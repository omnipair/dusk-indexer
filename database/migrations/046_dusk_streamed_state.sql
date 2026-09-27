BEGIN;
-- Current protocol state from streamed events, as the v1 indexer keeps its
-- positions from events. Nothing here reads program accounts: every view is a
-- fold over canonical confirmed or finalized events in stream order (slot,
-- then arrival). State covers markets created after ingestion of this
-- release began.

CREATE INDEX dusk_streamed_state_events ON dusk_ingestion.event_observations
  (cluster,program_id,idl_hash,protocol_revision,event_name,slot,observation_id)
  WHERE commitment IN ('confirmed','finalized');

CREATE VIEW dusk_ingestion.streamed_events AS
SELECT o.cluster,o.program_id,o.idl_hash,o.protocol_revision,o.event_key,o.observation_id,o.slot,
  o.transaction_signature AS signature,o.event_name,o.decoded_payload AS payload,o.payload_hash,s.time
FROM dusk_ingestion.canonical_events c
JOIN dusk_ingestion.event_observations o USING(cluster,program_id,idl_hash,protocol_revision,event_key,observation_id)
JOIN dusk_ingestion.event_stream s USING(cluster,program_id,idl_hash,protocol_revision,event_key)
WHERE c.commitment IN ('confirmed','finalized') AND o.commitment=c.commitment;

-- One row per market, from MarketCreated.
CREATE VIEW dusk_ingestion.streamed_markets AS
SELECT DISTINCT ON (cluster,program_id,idl_hash,protocol_revision,payload->>'market')
  cluster,program_id,idl_hash,protocol_revision,payload->>'market' AS market,
  payload->>'base_mint' AS base_mint,payload->>'quote_mint' AS quote_mint,payload->>'ylp_mint' AS ylp_mint,
  payload->>'base_hlp_mint' AS base_hlp_mint,payload->>'quote_hlp_mint' AS quote_hlp_mint,
  slot AS created_slot,time AS created_at,payload
FROM dusk_ingestion.streamed_events WHERE event_name='MarketCreated'
ORDER BY cluster,program_id,idl_hash,protocol_revision,payload->>'market',slot,observation_id;

-- Every LP mint with its market and kind.
CREATE VIEW dusk_ingestion.streamed_lp_mints AS
SELECT cluster,program_id,idl_hash,protocol_revision,market,mint AS lp_mint,kind
FROM dusk_ingestion.streamed_markets
CROSS JOIN LATERAL (VALUES (ylp_mint,'ylp'),(base_hlp_mint,'base_hlp'),(quote_hlp_mint,'quote_hlp')) AS m(mint,kind);

-- Leverage positions: the last event decides open or closed; the last
-- Opened/Updated carries the post-state.
CREATE VIEW dusk_ingestion.streamed_leverage_positions AS
WITH lifecycle AS (
  SELECT DISTINCT ON (cluster,program_id,idl_hash,protocol_revision,payload->>'position')
    cluster,program_id,idl_hash,protocol_revision,payload->>'position' AS position,event_name,slot,time
  FROM dusk_ingestion.streamed_events
  WHERE event_name IN ('LeveragePositionOpened','LeveragePositionUpdated','LeveragePositionClosed',
    'LeveragePositionLiquidated')
    OR (event_name='DebtFreePositionClosed' AND (payload->>'leverage')::boolean)
  ORDER BY cluster,program_id,idl_hash,protocol_revision,payload->>'position',slot DESC,observation_id DESC
), state AS (
  SELECT DISTINCT ON (cluster,program_id,idl_hash,protocol_revision,payload->>'position')
    cluster,program_id,idl_hash,protocol_revision,payload->>'position' AS position,payload
  FROM dusk_ingestion.streamed_events
  WHERE event_name IN ('LeveragePositionOpened','LeveragePositionUpdated')
  ORDER BY cluster,program_id,idl_hash,protocol_revision,payload->>'position',slot DESC,observation_id DESC
)
SELECT l.cluster,l.program_id,l.idl_hash,l.protocol_revision,l.position,
  s.payload->>'market' AS market,s.payload->>'owner' AS owner,
  s.payload->>'debt_asset_mint' AS debt_asset_mint,s.payload->>'collateral_asset_mint' AS collateral_asset_mint,
  (s.payload->>'collateral_amount')::numeric AS collateral_amount,(s.payload->>'debt_amount')::numeric AS debt_amount,
  (s.payload->>'debt_shares')::numeric AS debt_shares,(s.payload->>'closeout_value')::numeric AS closeout_value,
  l.event_name IN ('LeveragePositionOpened','LeveragePositionUpdated') AS open,
  l.event_name AS last_event,l.slot AS last_slot,l.time AS last_time
FROM lifecycle l JOIN state s USING(cluster,program_id,idl_hash,protocol_revision,position);

-- Borrow positions. Each lending event carries the position's post-state for
-- what it changes: collateral from the latest collateral or liquidation event,
-- fixed debt shares from the latest debt or liquidation event, the auction side
-- from the latest event that reports it (255 is none), and closure from the
-- latest event overall. A position reopened under the same id is open again.
CREATE VIEW dusk_ingestion.streamed_borrow_events AS
SELECT cluster,program_id,idl_hash,protocol_revision,
  COALESCE(payload->>'position',payload->>'borrow_position') AS position,
  COALESCE(payload->>'owner',payload->>'borrower') AS owner,payload->>'market' AS market,
  event_name,slot,observation_id,time,payload
FROM dusk_ingestion.streamed_events
WHERE event_name IN ('MarketCollateralDeposited','MarketCollateralWithdrawn','MarketDebtUpdated','BorrowPositionLiquidated',
    'LiquidationAuctionStarted','LiquidationAuctionCancelled')
  OR (event_name='DebtFreePositionClosed' AND NOT (payload->>'leverage')::boolean);

CREATE VIEW dusk_ingestion.streamed_borrow_positions AS
WITH latest AS (
  SELECT DISTINCT ON (cluster,program_id,idl_hash,protocol_revision,position)
    cluster,program_id,idl_hash,protocol_revision,position,owner,market,event_name,slot,time,
    event_name='DebtFreePositionClosed' OR COALESCE((payload->>'closed')::boolean,false) AS closed
  FROM dusk_ingestion.streamed_borrow_events
  ORDER BY cluster,program_id,idl_hash,protocol_revision,position,slot DESC,observation_id DESC
), collateral AS (
  SELECT DISTINCT ON (cluster,program_id,idl_hash,protocol_revision,position)
    cluster,program_id,idl_hash,protocol_revision,position,
    (payload->>'base_collateral')::numeric AS base_collateral,(payload->>'quote_collateral')::numeric AS quote_collateral
  FROM dusk_ingestion.streamed_borrow_events
  WHERE event_name IN ('MarketCollateralDeposited','MarketCollateralWithdrawn','BorrowPositionLiquidated')
  ORDER BY cluster,program_id,idl_hash,protocol_revision,position,slot DESC,observation_id DESC
), shares AS (
  SELECT DISTINCT ON (cluster,program_id,idl_hash,protocol_revision,position)
    cluster,program_id,idl_hash,protocol_revision,position,
    (payload->>'fixed_base_shares')::numeric AS fixed_base_shares,(payload->>'fixed_quote_shares')::numeric AS fixed_quote_shares
  FROM dusk_ingestion.streamed_borrow_events WHERE event_name IN ('MarketDebtUpdated','BorrowPositionLiquidated')
  ORDER BY cluster,program_id,idl_hash,protocol_revision,position,slot DESC,observation_id DESC
), health AS (
  SELECT DISTINCT ON (cluster,program_id,idl_hash,protocol_revision,position)
    cluster,program_id,idl_hash,protocol_revision,position,
    (payload->>'global_health_base_contribution_for_quote_debt')::numeric AS base_contribution_for_quote_debt,
    (payload->>'global_health_quote_contribution_for_base_debt')::numeric AS quote_contribution_for_base_debt,
    (payload->>'base_liquidation_cf_bps')::int AS base_liquidation_cf_bps,(payload->>'quote_liquidation_cf_bps')::int AS quote_liquidation_cf_bps
  FROM dusk_ingestion.streamed_borrow_events
  WHERE event_name IN ('MarketCollateralDeposited','MarketCollateralWithdrawn','MarketDebtUpdated','BorrowPositionLiquidated')
  ORDER BY cluster,program_id,idl_hash,protocol_revision,position,slot DESC,observation_id DESC
), auction AS (
  SELECT DISTINCT ON (cluster,program_id,idl_hash,protocol_revision,position)
    cluster,program_id,idl_hash,protocol_revision,position,
    CASE event_name WHEN 'LiquidationAuctionCancelled' THEN 255 ELSE (payload->>'auction_debt_asset')::int END AS auction_debt_asset
  FROM dusk_ingestion.streamed_borrow_events
  WHERE event_name IN ('MarketCollateralDeposited','MarketDebtUpdated','BorrowPositionLiquidated',
    'LiquidationAuctionStarted','LiquidationAuctionCancelled')
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

-- LP and hLP balances per owner: mints and burns from liquidity events,
-- transfers from the Token-2022 transfer hook every LP mint carries.
CREATE VIEW dusk_ingestion.streamed_lp_movements AS
SELECT e.cluster,e.program_id,e.idl_hash,e.protocol_revision,m.market,m.ylp_mint AS lp_mint,'ylp' AS kind,
  e.payload->>'owner' AS owner,
  CASE e.event_name WHEN 'LiquidityAdded' THEN 1 ELSE -1 END*(e.payload->>'ylp_amount')::numeric AS delta,e.slot,e.observation_id
FROM dusk_ingestion.streamed_events e
JOIN dusk_ingestion.streamed_markets m ON (m.cluster,m.program_id,m.idl_hash,m.protocol_revision,m.market)=
  (e.cluster,e.program_id,e.idl_hash,e.protocol_revision,e.payload->>'market')
WHERE e.event_name IN ('LiquidityAdded','LiquidityRemoved')
UNION ALL
SELECT e.cluster,e.program_id,e.idl_hash,e.protocol_revision,m.market,
  CASE e.payload->>'asset_side' WHEN '0' THEN m.base_hlp_mint ELSE m.quote_hlp_mint END,
  CASE e.payload->>'asset_side' WHEN '0' THEN 'base_hlp' ELSE 'quote_hlp' END,
  e.payload->>'owner',
  CASE e.event_name WHEN 'HlpOpened' THEN 1 ELSE -1 END*(e.payload->>'hlp_amount')::numeric,e.slot,e.observation_id
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
WHERE e.event_name='LpTransferred';

CREATE VIEW dusk_ingestion.streamed_lp_balances AS
SELECT cluster,program_id,idl_hash,protocol_revision,market,lp_mint,kind,owner,
  sum(delta) AS amount,max(slot) AS last_slot
FROM dusk_ingestion.streamed_lp_movements
GROUP BY cluster,program_id,idl_hash,protocol_revision,market,lp_mint,kind,owner;

-- Market observations from the permissionless crank.
CREATE VIEW dusk_ingestion.streamed_market_observations AS
SELECT cluster,program_id,idl_hash,protocol_revision,event_key,observation_id,slot,time,signature,
  payload->>'market' AS market,(payload->>'ylp_supply')::numeric AS ylp_supply,
  payload->'base' AS base,payload->'quote' AS quote
FROM dusk_ingestion.streamed_events WHERE event_name='MarketObserved';
COMMIT;
