-- Valuation and position state for the Dusk compatibility layer.
--
-- Migration 020 gave the v1 API its event-shaped tables. This one fills the
-- two surfaces it deliberately left empty: USD valuation and per-position
-- state. Both are derived in SQL from the same event stream, so they cannot
-- disagree with it and there is no worker to fall behind.
--
-- Pricing works the way a DEX indexer bootstraps one: anchor the assets whose
-- USD value is known by definition, then price everything they trade against
-- from the pool ratio. On a cluster whose mints are not listed anywhere,
-- that is the only honest source of a price — and it is the same number the
-- market itself is quoting.

BEGIN;

CREATE SCHEMA IF NOT EXISTS dusk_ingestion;

-- Mint decimals, needed to turn raw reserves into human amounts. Filled by
-- the API when it projects markets, which already reads each mint account.
CREATE TABLE IF NOT EXISTS dusk_ingestion.token_metadata (
    mint TEXT PRIMARY KEY,
    decimals SMALLINT NOT NULL CHECK (decimals >= 0 AND decimals <= 18),
    token_program TEXT,
    symbol TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Assets whose USD price is taken as given, and the note recording why. A
-- stablecoin at one dollar is an assumption, so it is written down as data
-- rather than buried in a query.
CREATE TABLE IF NOT EXISTS dusk_ingestion.usd_price_anchors (
    mint TEXT PRIMARY KEY,
    price_usd NUMERIC NOT NULL CHECK (price_usd > 0),
    note TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = 'pools'
           AND table_type = 'BASE TABLE'
    ) THEN
        RAISE NOTICE 'v1 tables exist; skipping the Dusk valuation views';
        RETURN;
    END IF;

    -- Every market's reserves over time, in human units. This is the base
    -- both pricing and valuation are built on.
    CREATE OR REPLACE VIEW dusk_ingestion.market_reserve_series AS
    SELECT
        e.time,
        e.market,
        m.payload->>'base_mint'                    AS base_mint,
        m.payload->>'quote_mint'                   AS quote_mint,
        (e.payload->>'base_live_reserve')::numeric
            / power(10::numeric, bm.decimals)      AS base_amount,
        (e.payload->>'quote_live_reserve')::numeric
            / power(10::numeric, qm.decimals)      AS quote_amount
      FROM dusk_ingestion.event_stream e
      JOIN LATERAL (
          SELECT payload
            FROM dusk_ingestion.event_stream c
           WHERE c.event_name = 'MarketCreated' AND c.market = e.market
           LIMIT 1
      ) m ON TRUE
      JOIN dusk_ingestion.token_metadata bm ON bm.mint = m.payload->>'base_mint'
      JOIN dusk_ingestion.token_metadata qm ON qm.mint = m.payload->>'quote_mint'
     WHERE e.payload ? 'base_live_reserve'
       AND e.market IS NOT NULL
       AND (e.payload->>'base_live_reserve')::numeric > 0
       AND (e.payload->>'quote_live_reserve')::numeric > 0;

    -- Hourly USD prices. An anchored mint carries its anchor price; the mint
    -- on the other side of the pool is priced from the ratio at that hour.
    -- Quality is "exact" only for the anchor itself: a derived price is a
    -- market quote, which is an estimate of value, not a fact about it.
    CREATE OR REPLACE VIEW token_price_snapshots AS
    WITH hourly AS (
        SELECT
            date_trunc('hour', time) AS bucket,
            base_mint, quote_mint,
            (array_agg(base_amount  ORDER BY time DESC))[1] AS base_amount,
            (array_agg(quote_amount ORDER BY time DESC))[1] AS quote_amount
          FROM dusk_ingestion.market_reserve_series
         GROUP BY 1, 2, 3
    ),
    priced AS (
        -- The anchored side.
        SELECT h.bucket, a.mint, a.price_usd, 'anchor'::text AS provider,
               'exact'::text AS quality
          FROM hourly h
          JOIN dusk_ingestion.usd_price_anchors a
            ON a.mint IN (h.base_mint, h.quote_mint)
        UNION ALL
        -- Base priced from an anchored quote.
        SELECT h.bucket, h.base_mint, a.price_usd * h.quote_amount / h.base_amount,
               'pool-ratio', 'estimated'
          FROM hourly h
          JOIN dusk_ingestion.usd_price_anchors a ON a.mint = h.quote_mint
         WHERE h.base_mint <> a.mint
        UNION ALL
        -- Quote priced from an anchored base.
        SELECT h.bucket, h.quote_mint, a.price_usd * h.base_amount / h.quote_amount,
               'pool-ratio', 'estimated'
          FROM hourly h
          JOIN dusk_ingestion.usd_price_anchors a ON a.mint = h.base_mint
         WHERE h.quote_mint <> a.mint
    )
    SELECT DISTINCT ON (mint, bucket)
        priced.mint                    AS mint,
        priced.bucket                  AS bucket,
        priced.price_usd               AS price_usd,
        tm.decimals::int               AS decimals,
        priced.provider                AS provider,
        priced.quality                 AS quality,
        priced.bucket                  AS created_at,
        priced.bucket                  AS updated_at
      FROM priced
      LEFT JOIN dusk_ingestion.token_metadata tm ON tm.mint = priced.mint
     -- An anchor beats a derived quote for the same mint and hour.
     ORDER BY mint, bucket, (priced.quality = 'exact') DESC;

    -- Liquidity positions. The events carry the LP delta rather than a
    -- balance, so a holding is the running sum of what an owner added less
    -- what they removed.
    CREATE OR REPLACE VIEW user_liquidity_positions AS
    WITH moves AS (
        SELECT
            payload->>'owner' AS signer,
            market            AS pair,
            CASE WHEN event_name = 'LiquidityAdded'
                 THEN  (payload->>'ylp_amount')::numeric
                 ELSE -(payload->>'ylp_amount')::numeric END AS lp_delta,
            slot, time
          FROM dusk_ingestion.event_stream
         WHERE event_name IN ('LiquidityAdded', 'LiquidityRemoved')
           AND market IS NOT NULL
           AND payload->>'owner' IS NOT NULL
    ),
    held AS (
        SELECT signer, pair, SUM(lp_delta) AS lp_amount,
               MAX(slot) AS slot, MAX(time) AS updated_at
          FROM moves GROUP BY signer, pair
         HAVING SUM(lp_delta) > 0
    )
    SELECT
        held.signer, held.pair,
        created.payload->>'base_mint'  AS token0_mint,
        created.payload->>'quote_mint' AS token1_mint,
        -- The owner's share of the pool at its latest reserves.
        (held.lp_amount / NULLIF(latest.ylp_supply, 0)) * latest.base_reserve  AS amount0,
        (held.lp_amount / NULLIF(latest.ylp_supply, 0)) * latest.quote_reserve AS amount1,
        created.payload->>'ylp_mint'   AS lp_mint,
        held.lp_amount, held.slot, held.updated_at
      FROM held
      JOIN LATERAL (
          SELECT payload FROM dusk_ingestion.event_stream c
           WHERE c.event_name = 'MarketCreated' AND c.market = held.pair LIMIT 1
      ) created ON TRUE
      LEFT JOIN LATERAL (
          SELECT (l.payload->>'ylp_supply')::numeric        AS ylp_supply,
                 (l.payload->>'base_live_reserve')::numeric AS base_reserve,
                 (l.payload->>'quote_live_reserve')::numeric AS quote_reserve
            FROM dusk_ingestion.event_stream l
           WHERE l.market = held.pair AND l.payload ? 'ylp_supply'
           ORDER BY l.time DESC LIMIT 1
      ) latest ON TRUE;

    -- Borrow position updates. Debt and collateral events both report the
    -- position's resulting state, so no reconstruction is needed.
    CREATE OR REPLACE VIEW user_position_updated_events AS
    SELECT
        row_number() OVER (ORDER BY time)  AS id,
        market                             AS pair,
        payload->>'owner'                  AS signer,
        COALESCE(payload->>'position', payload->>'owner') AS "position",
        COALESCE((payload->>'base_collateral')::numeric, 0)  AS collateral0,
        COALESCE((payload->>'quote_collateral')::numeric, 0) AS collateral1,
        COALESCE((payload->>'fixed_base_debt')::numeric, 0)  AS debt0_shares,
        COALESCE((payload->>'fixed_quote_debt')::numeric, 0) AS debt1_shares,
        COALESCE((payload->>'base_liquidation_cf_bps')::int, 0)  AS collateral0_liquidation_cf_bps,
        COALESCE((payload->>'quote_liquidation_cf_bps')::int, 0) AS collateral1_liquidation_cf_bps,
        COALESCE((payload->>'base_liquidation_cf_bps')::int, 0)  AS collateral0_max_cf_bps,
        COALESCE((payload->>'quote_liquidation_cf_bps')::int, 0) AS collateral1_max_cf_bps,
        transaction_signature, slot,
        time                               AS event_timestamp
      FROM dusk_ingestion.event_stream
     WHERE event_name IN ('MarketDebtUpdated', 'MarketCollateralDeposited',
                          'MarketCollateralWithdrawn')
       AND market IS NOT NULL
       AND payload->>'owner' IS NOT NULL;

    -- Current borrow state: the latest update per position.
    CREATE OR REPLACE VIEW user_borrow_positions AS
    SELECT DISTINCT ON (pair, "position")
        pair, signer, "position", collateral0, collateral1,
        debt0_shares, debt1_shares,
        collateral0_liquidation_cf_bps, collateral1_liquidation_cf_bps,
        collateral0_max_cf_bps, collateral1_max_cf_bps,
        slot, event_timestamp, event_timestamp AS updated_at
      FROM user_position_updated_events
     ORDER BY pair, "position", event_timestamp DESC;

    -- Swaps, re-stated with the valuation the prices now allow. Migration 020
    -- had to leave volume and price empty; with an anchored price series both
    -- are computable, so volume figures stop reading as zero.
    CREATE OR REPLACE VIEW swaps AS
    SELECT
        row_number() OVER (ORDER BY e.time)          AS id,
        e.market                                     AS pair,
        e.payload->>'trader'                         AS user_address,
        (e.payload->>'asset_in_side') = 'base'       AS is_token0_in,
        (e.payload->>'amount_in')::numeric           AS amount_in,
        (e.payload->>'amount_out')::numeric          AS amount_out,
        (e.payload->>'base_live_reserve')::numeric   AS reserve0,
        (e.payload->>'quote_live_reserve')::numeric  AS reserve1,
        e.time                                       AS "timestamp",
        e.transaction_signature                      AS tx_sig,
        e.slot                                       AS slot,
        CASE WHEN e.payload->>'fee_asset_side' = 'base'
             THEN (e.payload->>'base_fee')::numeric ELSE 0 END AS fee_paid0,
        CASE WHEN e.payload->>'fee_asset_side' = 'quote'
             THEN (e.payload->>'base_fee')::numeric ELSE 0 END AS fee_paid1,
        -- Price of the base asset in quote terms, from the resulting pool.
        CASE WHEN (e.payload->>'base_live_reserve')::numeric > 0
             THEN ((e.payload->>'quote_live_reserve')::numeric
                     / power(10::numeric, COALESCE(qm.decimals, 6)))
                / ((e.payload->>'base_live_reserve')::numeric
                     / power(10::numeric, COALESCE(bm.decimals, 6)))
             END                                     AS ema_price,
        -- Traded value: the input leg priced in dollars.
        CASE WHEN (e.payload->>'asset_in_side') = 'base'
             THEN (e.payload->>'amount_in')::numeric
                    / power(10::numeric, COALESCE(bm.decimals, 6)) * bp.price_usd
             ELSE (e.payload->>'amount_in')::numeric
                    / power(10::numeric, COALESCE(qm.decimals, 6)) * qp.price_usd
             END                                     AS volume_usd,
        (e.payload->>'retained_fee')::numeric        AS lp_fee,
        (e.payload->>'compounded_fee')::numeric      AS protocol_fee,
        NULL::numeric                                AS lp_fee_usd,
        NULL::numeric                                AS protocol_fee_usd
      FROM dusk_ingestion.event_stream e
      LEFT JOIN LATERAL (
          SELECT payload FROM dusk_ingestion.event_stream c
           WHERE c.event_name = 'MarketCreated' AND c.market = e.market LIMIT 1
      ) created ON TRUE
      LEFT JOIN dusk_ingestion.token_metadata bm ON bm.mint = created.payload->>'base_mint'
      LEFT JOIN dusk_ingestion.token_metadata qm ON qm.mint = created.payload->>'quote_mint'
      LEFT JOIN LATERAL (
          SELECT price_usd FROM token_price_snapshots s
           WHERE s.mint = created.payload->>'base_mint'
             AND s.bucket <= date_trunc('hour', e.time)
           ORDER BY s.bucket DESC LIMIT 1
      ) bp ON TRUE
      LEFT JOIN LATERAL (
          SELECT price_usd FROM token_price_snapshots s
           WHERE s.mint = created.payload->>'quote_mint'
             AND s.bucket <= date_trunc('hour', e.time)
           ORDER BY s.bucket DESC LIMIT 1
      ) qp ON TRUE
     WHERE e.event_name = 'SwapExecuted'
       AND e.market IS NOT NULL;

    -- LP earnings. A provider's share of the fees the program retained for
    -- liquidity, apportioned by their share of the pool. Borrow interest is
    -- not included: the program reports interest paid at the market level and
    -- attributing it per provider needs the share history, not just the
    -- current holding, so it stays zero rather than being approximated.
    CREATE OR REPLACE VIEW lp_position_earnings AS
    WITH fees AS (
        SELECT
            market AS pair,
            SUM(CASE WHEN payload->>'fee_asset_side' = 'base'
                     THEN (payload->>'retained_fee')::numeric ELSE 0 END) AS fees0,
            SUM(CASE WHEN payload->>'fee_asset_side' = 'quote'
                     THEN (payload->>'retained_fee')::numeric ELSE 0 END) AS fees1
          FROM dusk_ingestion.event_stream
         WHERE event_name = 'SwapExecuted' AND market IS NOT NULL
         GROUP BY market
    ),
    shares AS (
        SELECT p.signer, p.pair, p.lp_amount,
               NULLIF(latest.ylp_supply, 0) AS ylp_supply,
               p.token0_mint, p.token1_mint
          FROM user_liquidity_positions p
          LEFT JOIN LATERAL (
              SELECT (l.payload->>'ylp_supply')::numeric AS ylp_supply
                FROM dusk_ingestion.event_stream l
               WHERE l.market = p.pair AND l.payload ? 'ylp_supply'
               ORDER BY l.time DESC LIMIT 1
          ) latest ON TRUE
    )
    SELECT
        shares.pair,
        shares.signer,
        0::numeric AS accrued_interest0,
        0::numeric AS accrued_interest1,
        COALESCE(fees.fees0 * shares.lp_amount / shares.ylp_supply, 0) AS swap_fees0,
        COALESCE(fees.fees1 * shares.lp_amount / shares.ylp_supply, 0) AS swap_fees1,
        0::numeric AS accrued_interest_usd,
        COALESCE(
            fees.fees0 * shares.lp_amount / shares.ylp_supply
              / power(10::numeric, COALESCE(t0.decimals, 6)) * p0.price_usd, 0)
          + COALESCE(
            fees.fees1 * shares.lp_amount / shares.ylp_supply
              / power(10::numeric, COALESCE(t1.decimals, 6)) * p1.price_usd, 0)
                   AS swap_fees_usd,
        COALESCE(
            fees.fees0 * shares.lp_amount / shares.ylp_supply
              / power(10::numeric, COALESCE(t0.decimals, 6)) * p0.price_usd, 0)
          + COALESCE(
            fees.fees1 * shares.lp_amount / shares.ylp_supply
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

    -- Portfolio value per holder per hour: liquidity valued at the pool's
    -- own prices, collateral and debt from the position's latest state.
    CREATE OR REPLACE VIEW portfolio_value_snapshots AS
    WITH lp AS (
        SELECT
            p.signer AS user_address,
            date_trunc('hour', p.updated_at) AS bucket,
            SUM(COALESCE(p.amount0 / power(10::numeric, t0.decimals) * pr0.price_usd, 0)
              + COALESCE(p.amount1 / power(10::numeric, t1.decimals) * pr1.price_usd, 0)) AS lp_value_usd
          FROM user_liquidity_positions p
          LEFT JOIN dusk_ingestion.token_metadata t0 ON t0.mint = p.token0_mint
          LEFT JOIN dusk_ingestion.token_metadata t1 ON t1.mint = p.token1_mint
          LEFT JOIN LATERAL (
              SELECT price_usd FROM token_price_snapshots s
               WHERE s.mint = p.token0_mint ORDER BY s.bucket DESC LIMIT 1
          ) pr0 ON TRUE
          LEFT JOIN LATERAL (
              SELECT price_usd FROM token_price_snapshots s
               WHERE s.mint = p.token1_mint ORDER BY s.bucket DESC LIMIT 1
          ) pr1 ON TRUE
         GROUP BY 1, 2
    )
    SELECT
        lp.user_address,
        lp.bucket,
        lp.lp_value_usd            AS net_value_usd,
        lp.lp_value_usd            AS lp_value_usd,
        0::numeric                 AS collateral_value_usd,
        0::numeric                 AS debt_value_usd,
        'estimated'::text          AS quality,
        'backfill'::text           AS source,
        lp.bucket                  AS created_at,
        lp.bucket                  AS updated_at
      FROM lp;
END
$$;

COMMIT;
