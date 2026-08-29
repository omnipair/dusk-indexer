-- v1 API compatibility over Dusk ingestion.
--
-- The data API's endpoints, and every app feature built on them — activity
-- history, market lists, portfolio, charts — query the original Omnipair
-- tables by name. Rather than rewrite those endpoints against a new schema
-- (which would have meant changing a contract the app already speaks), the
-- Dusk event stream is projected back into the shapes they already expect.
-- The API code is untouched; only where its rows come from changes.
--
-- These are views, not tables: events are the record of truth and are already
-- stored once. A view cannot drift from them, and re-deriving is free next to
-- the cost of a second copy that can disagree.
--
-- Applied only where the v1 tables are absent. A deployment that has the real
-- Omnipair schema keeps it — the views would otherwise shadow live data.

BEGIN;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = 'pools'
           AND table_type = 'BASE TABLE'
    ) THEN
        RAISE NOTICE 'v1 tables exist; skipping the Dusk compatibility views';
        RETURN;
    END IF;

    -- Markets. One row per created market, carrying the identity and fee
    -- terms the pool endpoints read. Dusk has no fixed collateral factor —
    -- it is solved per position — so fixed_cf_bps is NULL rather than a
    -- number that would read as a real limit.
    CREATE OR REPLACE VIEW pools AS
    SELECT
        row_number() OVER (ORDER BY time)          AS id,
        market                                     AS pair_address,
        payload->>'base_mint'                      AS token0,
        payload->>'quote_mint'                     AS token1,
        payload->>'ylp_mint'                       AS lp_mint,
        'dynamic'::text                            AS rate_model,
        (payload->>'swap_fee_bps')::int            AS swap_fee_bps,
        NULL::bigint                               AS half_life,
        NULL::int                                  AS fixed_cf_bps,
        payload->>'params_hash'                    AS params_hash,
        (payload->>'version')::int                 AS version,
        TRUE                                       AS visible,
        time                                       AS created_at,
        slot                                       AS slot
      FROM dusk_ingestion.event_stream
     WHERE event_name = 'MarketCreated'
       AND market IS NOT NULL;

    -- Swaps. The event carries both post-trade reserves, so the reserve
    -- columns are real rather than reconstructed. Fees are attributed to the
    -- side the program charged them on.
    CREATE OR REPLACE VIEW swaps AS
    SELECT
        row_number() OVER (ORDER BY time)          AS id,
        market                                     AS pair,
        payload->>'trader'                         AS user_address,
        (payload->>'asset_in_side') = 'base'       AS is_token0_in,
        (payload->>'amount_in')::numeric           AS amount_in,
        (payload->>'amount_out')::numeric          AS amount_out,
        (payload->>'base_live_reserve')::numeric   AS reserve0,
        (payload->>'quote_live_reserve')::numeric  AS reserve1,
        time                                       AS "timestamp",
        transaction_signature                      AS tx_sig,
        slot                                       AS slot,
        CASE WHEN payload->>'fee_asset_side' = 'base'
             THEN (payload->>'base_fee')::numeric ELSE 0 END AS fee_paid0,
        CASE WHEN payload->>'fee_asset_side' = 'quote'
             THEN (payload->>'base_fee')::numeric ELSE 0 END AS fee_paid1,
        -- Price and USD value need a price source this pipeline does not
        -- have; left NULL so the API reports them as unavailable instead of
        -- publishing a fabricated number.
        NULL::numeric                              AS ema_price,
        NULL::numeric                              AS volume_usd,
        -- Fee split as the program reports it: what stayed with liquidity
        -- providers versus what the protocol compounded.
        (payload->>'retained_fee')::numeric        AS lp_fee,
        (payload->>'compounded_fee')::numeric      AS protocol_fee,
        NULL::numeric                              AS lp_fee_usd,
        NULL::numeric                              AS protocol_fee_usd
      FROM dusk_ingestion.event_stream
     WHERE event_name = 'SwapExecuted'
       AND market IS NOT NULL;

    -- Liquidity. Adds and removes share one table in v1, distinguished by
    -- event_type, with removals recorded as the amounts credited to the owner.
    CREATE OR REPLACE VIEW adjust_liquidity AS
    SELECT
        row_number() OVER (ORDER BY time)          AS id,
        market                                     AS pair,
        payload->>'owner'                          AS user_address,
        CASE WHEN event_name = 'LiquidityAdded'
             THEN (payload->>'base_reserve_credit')::numeric
             ELSE (payload->>'base_owner_credit')::numeric END  AS amount0,
        CASE WHEN event_name = 'LiquidityAdded'
             THEN (payload->>'quote_reserve_credit')::numeric
             ELSE (payload->>'quote_owner_credit')::numeric END AS amount1,
        (payload->>'ylp_amount')::numeric          AS liquidity,
        transaction_signature                      AS tx_sig,
        time                                       AS "timestamp",
        CASE WHEN event_name = 'LiquidityAdded' THEN 'add' ELSE 'remove' END
                                                   AS event_type,
        slot                                       AS slot
      FROM dusk_ingestion.event_stream
     WHERE event_name IN ('LiquidityAdded', 'LiquidityRemoved')
       AND market IS NOT NULL;

    -- Collateral movements.
    CREATE OR REPLACE VIEW adjust_collateral_events AS
    SELECT
        row_number() OVER (ORDER BY time)          AS id,
        market                                     AS pair,
        COALESCE(payload->>'owner', payload->>'authority') AS signer,
        CASE WHEN payload->>'asset_side' = 'base'
             THEN (payload->>'amount')::numeric ELSE 0 END AS amount0,
        CASE WHEN payload->>'asset_side' = 'quote'
             THEN (payload->>'amount')::numeric ELSE 0 END AS amount1,
        transaction_signature                      AS transaction_signature,
        slot                                       AS slot,
        time                                       AS event_timestamp
      FROM dusk_ingestion.event_stream
     WHERE event_name IN ('MarketCollateralDeposited', 'MarketCollateralWithdrawn')
       AND market IS NOT NULL;

    -- Debt movements.
    CREATE OR REPLACE VIEW adjust_debt_events AS
    SELECT
        row_number() OVER (ORDER BY time)          AS id,
        market                                     AS pair,
        COALESCE(payload->>'owner', payload->>'authority') AS signer,
        CASE WHEN payload->>'asset_side' = 'base'
             THEN (payload->>'amount')::numeric ELSE 0 END AS amount0,
        CASE WHEN payload->>'asset_side' = 'quote'
             THEN (payload->>'amount')::numeric ELSE 0 END AS amount1,
        transaction_signature                      AS transaction_signature,
        slot                                       AS slot,
        time                                       AS event_timestamp
      FROM dusk_ingestion.event_stream
     WHERE event_name = 'MarketDebtUpdated'
       AND market IS NOT NULL;

    -- Pair state updates. In v1 this was a dedicated event; in Dusk every
    -- event that moves the pool carries the resulting reserves, so any event
    -- carrying them is one of these. The v1 interest breakdown has no Dusk
    -- counterpart and stays NULL rather than being invented.
    CREATE OR REPLACE VIEW update_pair_events AS
    SELECT
        row_number() OVER (ORDER BY time)          AS id,
        market                                     AS pair,
        NULL::text                                 AS signer,
        NULL::numeric                              AS price0_ema,
        NULL::numeric                              AS price1_ema,
        NULL::numeric                              AS rate0,
        NULL::numeric                              AS rate1,
        NULL::numeric                              AS accrued_interest0,
        NULL::numeric                              AS accrued_interest1,
        NULL::numeric                              AS lp_interest0,
        NULL::numeric                              AS lp_interest1,
        NULL::numeric                              AS protocol_interest0,
        NULL::numeric                              AS protocol_interest1,
        NULL::numeric                              AS cash_reserve0,
        NULL::numeric                              AS cash_reserve1,
        (payload->>'base_live_reserve')::numeric   AS reserve0_after_interest,
        (payload->>'quote_live_reserve')::numeric  AS reserve1_after_interest,
        transaction_signature                      AS transaction_signature,
        slot                                       AS slot,
        time                                       AS "timestamp"
      FROM dusk_ingestion.event_stream
     WHERE payload ? 'base_live_reserve'
       AND market IS NOT NULL;

    CREATE OR REPLACE VIEW user_position_liquidated_events AS
    SELECT
        row_number() OVER (ORDER BY time)          AS id,
        market                                     AS pair,
        payload->>'owner'                          AS signer,
        payload->>'position'                       AS "position",
        payload->>'liquidator'                     AS liquidator,
        COALESCE((payload->>'collateral_seized')::numeric, 0)  AS collateral0_liquidated,
        0::numeric                                 AS collateral1_liquidated,
        COALESCE((payload->>'debt_repaid')::numeric, 0)        AS debt0_liquidated,
        0::numeric                                 AS debt1_liquidated,
        0::numeric                                 AS collateral_price,
        0::numeric                                 AS shortfall,
        COALESCE((payload->>'incentive_bps')::numeric, 0)      AS liquidation_bonus_applied,
        0::numeric                                 AS k0,
        0::numeric                                 AS k1,
        transaction_signature                      AS transaction_signature,
        slot                                       AS slot,
        time                                       AS event_timestamp
      FROM dusk_ingestion.event_stream
     WHERE event_name = 'BorrowPositionLiquidated'
       AND market IS NOT NULL;

    -- Empty compatibility surfaces. These back position and earnings
    -- endpoints that need per-position state the daemon does not project
    -- yet. An empty view answers "nothing recorded", which the API already
    -- handles; a missing relation is a 500 the app cannot interpret.
    CREATE OR REPLACE VIEW user_lp_position_updated_events AS
    SELECT
        NULL::bigint AS id, NULL::text AS pair_address,
        NULL::numeric AS lp_amount, NULL::numeric AS amount0,
        NULL::numeric AS amount1, NULL::text AS signer,
        NULL::timestamptz AS "timestamp"
     WHERE FALSE;

    CREATE OR REPLACE VIEW user_position_updated_events AS
    SELECT
        NULL::bigint AS id, NULL::text AS pair, NULL::text AS signer,
        NULL::text AS "position", NULL::numeric AS collateral0,
        NULL::numeric AS collateral1, NULL::numeric AS debt0_shares,
        NULL::numeric AS debt1_shares,
        NULL::int AS collateral0_liquidation_cf_bps,
        NULL::int AS collateral1_liquidation_cf_bps,
        NULL::int AS collateral0_max_cf_bps, NULL::int AS collateral1_max_cf_bps,
        NULL::text AS transaction_signature, NULL::bigint AS slot,
        NULL::timestamptz AS event_timestamp
     WHERE FALSE;

    CREATE OR REPLACE VIEW user_liquidity_positions AS
    SELECT
        NULL::text AS signer, NULL::text AS pair, NULL::text AS token0_mint,
        NULL::text AS token1_mint, NULL::numeric AS amount0,
        NULL::numeric AS amount1, NULL::text AS lp_mint,
        NULL::numeric AS lp_amount, NULL::bigint AS slot,
        NULL::timestamptz AS updated_at
     WHERE FALSE;

    CREATE OR REPLACE VIEW user_borrow_positions AS
    SELECT
        NULL::text AS pair, NULL::text AS signer, NULL::text AS "position",
        NULL::numeric AS collateral0, NULL::numeric AS collateral1,
        NULL::numeric AS debt0_shares, NULL::numeric AS debt1_shares,
        NULL::int AS collateral0_liquidation_cf_bps,
        NULL::int AS collateral1_liquidation_cf_bps,
        NULL::int AS collateral0_max_cf_bps, NULL::int AS collateral1_max_cf_bps,
        NULL::bigint AS slot, NULL::timestamptz AS event_timestamp,
        NULL::timestamptz AS updated_at
     WHERE FALSE;

    CREATE OR REPLACE VIEW lp_position_earning_events AS
    SELECT
        NULL::bigint AS id, NULL::text AS pair, NULL::text AS signer,
        NULL::text AS source, NULL::text AS source_event_id,
        NULL::text AS source_tx_sig, NULL::bigint AS event_slot,
        NULL::timestamptz AS event_timestamp, NULL::numeric AS lp_amount,
        NULL::numeric AS total_supply, NULL::numeric AS lp_share,
        NULL::numeric AS token0_amount, NULL::numeric AS token1_amount,
        NULL::numeric AS token0_usd, NULL::numeric AS token1_usd,
        NULL::numeric AS total_usd, NULL::text AS price_quality,
        NULL::text AS allocation_quality,
        NULL::int AS source_instruction_index,
        NULL::text AS source_instruction_path,
        NULL::timestamptz AS created_at, NULL::timestamptz AS updated_at
     WHERE FALSE;

    -- USD valuation needs a price feed this deployment has no source for, so
    -- these stay empty. The endpoints built on them report "unavailable",
    -- which is true, rather than a number derived from nothing.
    CREATE OR REPLACE VIEW token_price_snapshots AS
    SELECT
        NULL::text AS mint, NULL::timestamptz AS bucket,
        NULL::numeric AS price_usd, NULL::int AS decimals,
        NULL::text AS provider, NULL::text AS quality,
        NULL::timestamptz AS created_at, NULL::timestamptz AS updated_at
     WHERE FALSE;

    CREATE OR REPLACE VIEW portfolio_value_snapshots AS
    SELECT
        NULL::text AS user_address, NULL::timestamptz AS bucket,
        NULL::numeric AS net_value_usd, NULL::numeric AS lp_value_usd,
        NULL::numeric AS collateral_value_usd, NULL::numeric AS debt_value_usd,
        NULL::text AS quality, NULL::text AS source,
        NULL::timestamptz AS created_at, NULL::timestamptz AS updated_at
     WHERE FALSE;

END
$$;

COMMIT;
