BEGIN;
-- Present senior LP names at the projection boundary. Historical observations,
-- their IDL revisions, source bytes and hashes remain immutable.
CREATE FUNCTION dusk_ingestion.senior_lp_payload(value jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE result jsonb; entry record; renamed text;
BEGIN
  IF jsonb_typeof(value)='object' THEN
    result='{}'::jsonb;
    FOR entry IN SELECT * FROM jsonb_each(value) LOOP
      renamed=replace(replace(replace(entry.key,'ylp','srlp'),'Ylp','Srlp'),'YLP','SRLP');
      IF result ? renamed THEN RAISE EXCEPTION 'Conflicting senior LP payload fields'; END IF;
      result=result||jsonb_build_object(renamed,dusk_ingestion.senior_lp_payload(entry.value));
    END LOOP;
    RETURN result;
  ELSIF jsonb_typeof(value)='array' THEN
    SELECT COALESCE(jsonb_agg(dusk_ingestion.senior_lp_payload(item) ORDER BY ordinal),'[]'::jsonb)
      INTO result FROM jsonb_array_elements(value) WITH ORDINALITY AS items(item,ordinal);
    RETURN result;
  END IF;
  RETURN value;
END $$;

CREATE OR REPLACE VIEW dusk_ingestion.streamed_events AS
SELECT o.cluster,o.program_id,o.idl_hash,o.protocol_revision,o.event_key,o.observation_id,o.slot,
  o.transaction_signature AS signature,o.event_name,dusk_ingestion.senior_lp_payload(o.decoded_payload) AS payload,o.payload_hash,s.time
FROM dusk_ingestion.canonical_events c
JOIN dusk_ingestion.event_observations o USING(cluster,program_id,idl_hash,protocol_revision,event_key,observation_id)
JOIN dusk_ingestion.event_stream s USING(cluster,program_id,idl_hash,protocol_revision,event_key)
WHERE c.commitment IN ('confirmed','finalized') AND o.commitment=c.commitment;

ALTER VIEW dusk_ingestion.streamed_markets RENAME COLUMN ylp_mint TO srlp_mint;
ALTER VIEW dusk_ingestion.streamed_governance_markets RENAME COLUMN eligible_ylp TO eligible_srlp;
ALTER VIEW dusk_ingestion.streamed_governance_markets RENAME COLUMN governance_locked_ylp TO governance_locked_srlp;

CREATE OR REPLACE VIEW pools AS
    SELECT
        row_number() OVER (ORDER BY time)          AS id,
        market                                     AS pair_address,
        senior_payload->>'base_mint'                      AS token0,
        senior_payload->>'quote_mint'                     AS token1,
        senior_payload->>'srlp_mint'                       AS lp_mint,
        'dynamic'::text                            AS rate_model,
        (senior_payload->>'swap_fee_bps')::int            AS swap_fee_bps,
        NULL::bigint                               AS half_life,
        NULL::int                                  AS fixed_cf_bps,
        senior_payload->>'params_hash'                    AS params_hash,
        (senior_payload->>'version')::int                 AS version,
        TRUE                                       AS visible,
        time                                       AS created_at,
        slot                                       AS slot
      FROM (SELECT e.*, dusk_ingestion.senior_lp_payload(e.payload) AS senior_payload FROM dusk_ingestion.event_stream e)
     WHERE event_name = 'MarketCreated'
       AND market IS NOT NULL;

CREATE OR REPLACE VIEW adjust_liquidity AS
    SELECT
        row_number() OVER (ORDER BY time)          AS id,
        market                                     AS pair,
        senior_payload->>'owner'                          AS user_address,
        CASE WHEN event_name = 'LiquidityAdded'
             THEN (senior_payload->>'base_reserve_credit')::numeric
             ELSE (senior_payload->>'base_owner_credit')::numeric END  AS amount0,
        CASE WHEN event_name = 'LiquidityAdded'
             THEN (senior_payload->>'quote_reserve_credit')::numeric
             ELSE (senior_payload->>'quote_owner_credit')::numeric END AS amount1,
        (senior_payload->>'srlp_amount')::numeric          AS liquidity,
        transaction_signature                      AS tx_sig,
        time                                       AS "timestamp",
        CASE WHEN event_name = 'LiquidityAdded' THEN 'add' ELSE 'remove' END
                                                   AS event_type,
        slot                                       AS slot
      FROM (SELECT e.*, dusk_ingestion.senior_lp_payload(e.payload) AS senior_payload FROM dusk_ingestion.event_stream e)
     WHERE event_name IN ('LiquidityAdded', 'LiquidityRemoved')
       AND market IS NOT NULL;

CREATE OR REPLACE VIEW user_liquidity_positions AS
    WITH moves AS (
        SELECT
            senior_payload->>'owner' AS signer,
            market            AS pair,
            CASE WHEN event_name = 'LiquidityAdded'
                 THEN  (senior_payload->>'srlp_amount')::numeric
                 ELSE -(senior_payload->>'srlp_amount')::numeric END AS lp_delta,
            slot, time
          FROM (SELECT e.*, dusk_ingestion.senior_lp_payload(e.payload) AS senior_payload FROM dusk_ingestion.event_stream e)
         WHERE event_name IN ('LiquidityAdded', 'LiquidityRemoved')
           AND market IS NOT NULL
           AND senior_payload->>'owner' IS NOT NULL
    ),
    held AS (
        SELECT signer, pair, SUM(lp_delta) AS lp_amount,
               MAX(slot) AS slot, MAX(time) AS updated_at
          FROM moves GROUP BY signer, pair
         HAVING SUM(lp_delta) > 0
    )
    SELECT
        held.signer, held.pair,
        created.senior_payload->>'base_mint'  AS token0_mint,
        created.senior_payload->>'quote_mint' AS token1_mint,
        
        (held.lp_amount / NULLIF(latest.srlp_supply, 0)) * latest.base_reserve  AS amount0,
        (held.lp_amount / NULLIF(latest.srlp_supply, 0)) * latest.quote_reserve AS amount1,
        created.senior_payload->>'srlp_mint'   AS lp_mint,
        held.lp_amount, held.slot, held.updated_at
      FROM held
      JOIN LATERAL (
          SELECT senior_payload FROM (SELECT e.*, dusk_ingestion.senior_lp_payload(e.payload) AS senior_payload FROM dusk_ingestion.event_stream e) c
           WHERE c.event_name = 'MarketCreated' AND c.market = held.pair LIMIT 1
      ) created ON TRUE
      LEFT JOIN LATERAL (
          SELECT (l.senior_payload->>'srlp_supply')::numeric        AS srlp_supply,
                 (l.senior_payload->>'base_live_reserve')::numeric AS base_reserve,
                 (l.senior_payload->>'quote_live_reserve')::numeric AS quote_reserve
            FROM (SELECT e.*, dusk_ingestion.senior_lp_payload(e.payload) AS senior_payload FROM dusk_ingestion.event_stream e) l
           WHERE l.market = held.pair AND l.senior_payload ? 'srlp_supply'
           ORDER BY l.time DESC LIMIT 1
      ) latest ON TRUE;

CREATE OR REPLACE VIEW lp_position_earnings AS
    WITH fees AS (
        SELECT
            market AS pair,
            SUM(CASE WHEN senior_payload->>'fee_asset_side' IN ('0','base')
                     THEN (senior_payload->>'retained_fee')::numeric ELSE 0 END) AS fees0,
            SUM(CASE WHEN senior_payload->>'fee_asset_side' IN ('1','quote')
                     THEN (senior_payload->>'retained_fee')::numeric ELSE 0 END) AS fees1
          FROM (SELECT e.*, dusk_ingestion.senior_lp_payload(e.payload) AS senior_payload FROM dusk_ingestion.event_stream e)
         WHERE event_name = 'SwapExecuted' AND market IS NOT NULL
         GROUP BY market
    ),
    shares AS (
        SELECT p.signer, p.pair, p.lp_amount,
               NULLIF(latest.srlp_supply, 0) AS srlp_supply,
               p.token0_mint, p.token1_mint
          FROM user_liquidity_positions p
          LEFT JOIN LATERAL (
              SELECT (l.senior_payload->>'srlp_supply')::numeric AS srlp_supply
                FROM (SELECT e.*, dusk_ingestion.senior_lp_payload(e.payload) AS senior_payload FROM dusk_ingestion.event_stream e) l
               WHERE l.market = p.pair AND l.senior_payload ? 'srlp_supply'
               ORDER BY l.time DESC LIMIT 1
          ) latest ON TRUE
    )
    SELECT
        shares.pair,
        shares.signer,
        0::numeric AS accrued_interest0,
        0::numeric AS accrued_interest1,
        COALESCE(fees.fees0 * shares.lp_amount / shares.srlp_supply, 0) AS swap_fees0,
        COALESCE(fees.fees1 * shares.lp_amount / shares.srlp_supply, 0) AS swap_fees1,
        0::numeric AS accrued_interest_usd,
        COALESCE(
            fees.fees0 * shares.lp_amount / shares.srlp_supply
              / power(10::numeric, COALESCE(t0.decimals, 6)) * p0.price_usd, 0)
          + COALESCE(
            fees.fees1 * shares.lp_amount / shares.srlp_supply
              / power(10::numeric, COALESCE(t1.decimals, 6)) * p1.price_usd, 0)
                   AS swap_fees_usd,
        COALESCE(
            fees.fees0 * shares.lp_amount / shares.srlp_supply
              / power(10::numeric, COALESCE(t0.decimals, 6)) * p0.price_usd, 0)
          + COALESCE(
            fees.fees1 * shares.lp_amount / shares.srlp_supply
              / power(10::numeric, COALESCE(t1.decimals, 6)) * p1.price_usd, 0)
                   AS total_earned_usd,
        now()      AS updated_at
      FROM shares
      LEFT JOIN fees ON fees.pair = shares.pair
      LEFT JOIN dusk_ingestion.token_metadata t0 ON t0.mint = shares.token0_mint
      LEFT JOIN dusk_ingestion.token_metadata t1 ON t1.mint = shares.token1_mint
      LEFT JOIN LATERAL (
          SELECT price_usd FROM token_price_snapshots s
           WHERE s.mint = shares.token0_mint ORDER BY s.bucket DESC LIMIT 1
      ) p0 ON TRUE
      LEFT JOIN LATERAL (
          SELECT price_usd FROM token_price_snapshots s
           WHERE s.mint = shares.token1_mint ORDER BY s.bucket DESC LIMIT 1
      ) p1 ON TRUE;

CREATE OR REPLACE VIEW dusk_ingestion.streamed_markets AS
SELECT DISTINCT ON (cluster,program_id,idl_hash,protocol_revision,payload->>'market')
  cluster,program_id,idl_hash,protocol_revision,payload->>'market' AS market,
  payload->>'base_mint' AS base_mint,payload->>'quote_mint' AS quote_mint,payload->>'srlp_mint' AS srlp_mint,
  payload->>'base_hlp_mint' AS base_hlp_mint,payload->>'quote_hlp_mint' AS quote_hlp_mint,
  (payload->>'base_decimals')::int AS base_decimals,(payload->>'quote_decimals')::int AS quote_decimals,
  slot AS created_slot,time AS created_at,payload
FROM dusk_ingestion.streamed_events WHERE event_name='MarketCreated'
ORDER BY cluster,program_id,idl_hash,protocol_revision,payload->>'market',slot,observation_id;

CREATE OR REPLACE VIEW dusk_ingestion.streamed_lp_mints AS
SELECT cluster,program_id,idl_hash,protocol_revision,market,mint AS lp_mint,kind
FROM dusk_ingestion.streamed_markets
CROSS JOIN LATERAL (VALUES (srlp_mint,'srlp'),(base_hlp_mint,'base_hlp'),(quote_hlp_mint,'quote_hlp')) AS m(mint,kind)
UNION
SELECT cluster,program_id,idl_hash,protocol_revision,payload->>'market',payload->>'new_mint',
  CASE payload->>'target_asset' WHEN '0' THEN 'base_hlp' ELSE 'quote_hlp' END
FROM dusk_ingestion.streamed_events WHERE event_name='HlpCohortRotated'
UNION
SELECT cluster,program_id,idl_hash,protocol_revision,payload->>'market',payload->>'mint','junior'
FROM dusk_ingestion.streamed_events WHERE event_name='JuniorCohortInitialized';

CREATE OR REPLACE VIEW dusk_ingestion.streamed_lp_movements AS
SELECT e.cluster,e.program_id,e.idl_hash,e.protocol_revision,m.market,m.srlp_mint AS lp_mint,'srlp' AS kind,
  e.payload->>'owner' AS owner,
  CASE e.event_name WHEN 'LiquidityAdded' THEN 1 ELSE -1 END*(e.payload->>'srlp_amount')::numeric AS delta,e.slot,e.observation_id
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

SELECT e.cluster,e.program_id,e.idl_hash,e.protocol_revision,e.payload->>'market',m.srlp_mint,'srlp',
  e.payload->>'owner',CASE e.payload->>'action' WHEN '0' THEN -(e.payload->>'senior_amount')::numeric
    ELSE (e.payload->>'senior_amount')::numeric END,e.slot,e.observation_id
FROM dusk_ingestion.streamed_events e
JOIN dusk_ingestion.streamed_markets m ON (m.cluster,m.program_id,m.idl_hash,m.protocol_revision,m.market)=
  (e.cluster,e.program_id,e.idl_hash,e.protocol_revision,e.payload->>'market')
WHERE e.event_name='TrancheConverted' AND e.payload->>'action' IN ('0','2')
UNION ALL

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

CREATE OR REPLACE VIEW dusk_ingestion.streamed_market_snapshots AS
SELECT e.cluster,e.program_id,e.idl_hash,e.protocol_revision,e.event_key,e.observation_id,e.slot,e.time,e.signature,
  e.payload_hash,m.market,
  jsonb_build_object('market',m.market,'srlp_mint',m.srlp_mint,'slot',e.payload->>'slot','srlp_supply',e.payload->>'srlp_supply',
    'base',(e.payload->'base')||jsonb_build_object('asset_mint',m.base_mint,'asset_decimals',m.base_decimals::text,
      'live_reserve',e.payload->>'base_live_reserve'),
    'quote',(e.payload->'quote')||jsonb_build_object('asset_mint',m.quote_mint,'asset_decimals',m.quote_decimals::text,
      'live_reserve',e.payload->>'quote_live_reserve')) AS payload
FROM dusk_ingestion.streamed_events e
JOIN dusk_ingestion.streamed_markets m ON (m.cluster,m.program_id,m.idl_hash,m.protocol_revision,m.market)=
  (e.cluster,e.program_id,e.idl_hash,e.protocol_revision,e.payload->>'market')
WHERE e.event_name='SwapExecuted' AND e.payload ?& ARRAY['srlp_supply','base','quote'];

CREATE OR REPLACE VIEW dusk_ingestion.streamed_governance_markets AS
SELECT m.cluster,m.program_id,m.idl_hash,m.protocol_revision,m.market,
  COALESCE(b.eligible_srlp,0) AS eligible_srlp,COALESCE(p.governance_locked_srlp,0) AS governance_locked_srlp
FROM dusk_ingestion.streamed_markets m
LEFT JOIN (SELECT cluster,program_id,idl_hash,protocol_revision,market,sum(amount) AS eligible_srlp
  FROM dusk_ingestion.streamed_lp_balances WHERE kind='srlp' AND owner<>market
  GROUP BY cluster,program_id,idl_hash,protocol_revision,market) b USING(cluster,program_id,idl_hash,protocol_revision,market)
LEFT JOIN (SELECT cluster,program_id,idl_hash,protocol_revision,market,sum(total_locked::numeric) AS governance_locked_srlp
  FROM dusk_ingestion.streamed_governance_proposals
  GROUP BY cluster,program_id,idl_hash,protocol_revision,market) p USING(cluster,program_id,idl_hash,protocol_revision,market);

ALTER TABLE dusk_ingestion.lp_token_scans DROP CONSTRAINT lp_token_scans_token_kind_check;
ALTER TABLE dusk_ingestion.lp_token_scans ADD CONSTRAINT lp_token_scans_token_kind_check
  CHECK (token_kind IN ('ylp','srlp','base_hlp','quote_hlp'));
CREATE OR REPLACE VIEW dusk_ingestion.native_lp_ownership AS
SELECT s.cluster,s.program_id,s.idl_hash,s.protocol_revision,s.market,s.lp_mint,
  CASE s.token_kind WHEN 'ylp' THEN 'srlp' ELSE s.token_kind END AS token_kind,
  s.slot AS source_slot,s.blockhash,s.block_time,s.observed_at,s.mint_slot,s.mint_supply,s.decimals,o.*
FROM dusk_ingestion.latest_lp_token_scans s JOIN dusk_ingestion.lp_token_observations o USING (scan_id);
COMMIT;
