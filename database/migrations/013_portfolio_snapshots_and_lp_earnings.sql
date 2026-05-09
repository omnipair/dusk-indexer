-- Migration: Portfolio snapshots and per-position LP earnings
-- Adds durable hourly portfolio valuation data and source-attributed LP earnings.

CREATE TABLE IF NOT EXISTS token_price_snapshots (
    mint TEXT NOT NULL,
    bucket TIMESTAMPTZ NOT NULL,
    price_usd NUMERIC NOT NULL,
    decimals INTEGER,
    provider TEXT NOT NULL DEFAULT 'birdeye',
    quality TEXT NOT NULL DEFAULT 'historical',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (mint, bucket, provider),
    CONSTRAINT token_price_snapshots_quality_check
      CHECK (quality IN ('historical', 'current', 'estimated', 'missing'))
);

CREATE TABLE IF NOT EXISTS portfolio_value_snapshots (
    user_address TEXT NOT NULL,
    bucket TIMESTAMPTZ NOT NULL,
    net_value_usd NUMERIC NOT NULL DEFAULT 0,
    lp_value_usd NUMERIC NOT NULL DEFAULT 0,
    collateral_value_usd NUMERIC NOT NULL DEFAULT 0,
    debt_value_usd NUMERIC NOT NULL DEFAULT 0,
    quality TEXT NOT NULL DEFAULT 'estimated',
    source TEXT NOT NULL DEFAULT 'backfill',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_address, bucket),
    CONSTRAINT portfolio_value_snapshots_quality_check
      CHECK (quality IN ('exact', 'estimated')),
    CONSTRAINT portfolio_value_snapshots_source_check
      CHECK (source IN ('snapshotter', 'backfill', 'manual'))
);

CREATE TABLE IF NOT EXISTS lp_position_earning_events (
    id BIGSERIAL PRIMARY KEY,
    pair TEXT NOT NULL,
    signer TEXT NOT NULL,
    source TEXT NOT NULL,
    source_event_id TEXT NOT NULL,
    source_tx_sig TEXT,
    event_slot BIGINT,
    event_timestamp TIMESTAMPTZ NOT NULL,
    lp_amount NUMERIC NOT NULL,
    total_supply NUMERIC NOT NULL,
    lp_share NUMERIC NOT NULL,
    token0_amount NUMERIC NOT NULL DEFAULT 0,
    token1_amount NUMERIC NOT NULL DEFAULT 0,
    token0_usd NUMERIC NOT NULL DEFAULT 0,
    token1_usd NUMERIC NOT NULL DEFAULT 0,
    total_usd NUMERIC NOT NULL DEFAULT 0,
    price_quality TEXT NOT NULL DEFAULT 'historical',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT lp_position_earning_events_source_check
      CHECK (source IN ('borrow_interest', 'swap_fee')),
    CONSTRAINT lp_position_earning_events_price_quality_check
      CHECK (price_quality IN ('historical', 'current', 'estimated', 'missing')),
    CONSTRAINT lp_position_earning_events_unique_source
      UNIQUE (pair, signer, source, source_event_id)
);

CREATE TABLE IF NOT EXISTS lp_position_earnings (
    pair TEXT NOT NULL,
    signer TEXT NOT NULL,
    accrued_interest0 NUMERIC NOT NULL DEFAULT 0,
    accrued_interest1 NUMERIC NOT NULL DEFAULT 0,
    swap_fees0 NUMERIC NOT NULL DEFAULT 0,
    swap_fees1 NUMERIC NOT NULL DEFAULT 0,
    accrued_interest_usd NUMERIC NOT NULL DEFAULT 0,
    swap_fees_usd NUMERIC NOT NULL DEFAULT 0,
    total_earned_usd NUMERIC NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (pair, signer)
);

CREATE INDEX IF NOT EXISTS idx_token_price_snapshots_mint_bucket
  ON token_price_snapshots (mint, bucket DESC);

CREATE INDEX IF NOT EXISTS idx_portfolio_value_snapshots_user_bucket
  ON portfolio_value_snapshots (user_address, bucket DESC);

CREATE INDEX IF NOT EXISTS idx_lp_position_earning_events_pair_slot
  ON lp_position_earning_events (pair, event_slot);

CREATE INDEX IF NOT EXISTS idx_lp_position_earning_events_signer_pair
  ON lp_position_earning_events (signer, pair);

CREATE INDEX IF NOT EXISTS idx_lp_position_earning_events_timestamp
  ON lp_position_earning_events (event_timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_lp_position_earnings_signer
  ON lp_position_earnings (signer);
