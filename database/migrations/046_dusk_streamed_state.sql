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
  o.transaction_signature AS signature,o.event_name,o.decoded_payload AS payload,s.time
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

-- Borrow positions: the last BorrowPositionUpdated snapshot is the account.
CREATE VIEW dusk_ingestion.streamed_borrow_positions AS
SELECT DISTINCT ON (cluster,program_id,idl_hash,protocol_revision,payload->>'position')
  cluster,program_id,idl_hash,protocol_revision,payload->>'position' AS position,
  payload->>'market' AS market,payload->>'owner' AS owner,
  (payload->>'base_collateral')::numeric AS base_collateral,(payload->>'quote_collateral')::numeric AS quote_collateral,
  (payload->>'fixed_base_shares')::numeric AS fixed_base_shares,(payload->>'fixed_quote_shares')::numeric AS fixed_quote_shares,
  NOT COALESCE((payload->>'closed')::boolean,false) AS open,
  slot AS last_slot,time AS last_time,payload
FROM dusk_ingestion.streamed_events WHERE event_name='BorrowPositionUpdated'
ORDER BY cluster,program_id,idl_hash,protocol_revision,payload->>'position',slot DESC,observation_id DESC;

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
