-- Migration: Create update_pair_events table for tracking interest accrual
-- Stores each UpdatePairEvent as a time-series row. Interest fields are deltas
-- since the previous event for that pair, enabling SUM() over time windows.

CREATE TABLE update_pair_events (
    id BIGSERIAL,
    pair VARCHAR(44) NOT NULL,
    signer VARCHAR(44) NOT NULL,
    price0_ema NUMERIC NOT NULL,
    price1_ema NUMERIC NOT NULL,
    rate0 NUMERIC NOT NULL,
    rate1 NUMERIC NOT NULL,
    accrued_interest0 NUMERIC NOT NULL,
    accrued_interest1 NUMERIC NOT NULL,
    lp_interest0 NUMERIC NOT NULL,
    lp_interest1 NUMERIC NOT NULL,
    protocol_interest0 NUMERIC NOT NULL,
    protocol_interest1 NUMERIC NOT NULL,
    cash_reserve0 NUMERIC NOT NULL,
    cash_reserve1 NUMERIC NOT NULL,
    reserve0_after_interest NUMERIC NOT NULL,
    reserve1_after_interest NUMERIC NOT NULL,
    transaction_signature VARCHAR(88) NOT NULL,
    slot BIGINT NOT NULL,
    "timestamp" TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (id, "timestamp"),
    CONSTRAINT update_pair_events_tx_sig_timestamp_key UNIQUE (transaction_signature, "timestamp")
);

SELECT create_hypertable('update_pair_events', 'timestamp', chunk_time_interval => INTERVAL '7 days', if_not_exists => TRUE);

CREATE INDEX idx_update_pair_events_pair ON update_pair_events USING btree (pair);
CREATE INDEX idx_update_pair_events_timestamp ON update_pair_events USING btree ("timestamp" DESC);
CREATE INDEX idx_update_pair_events_pair_timestamp ON update_pair_events USING btree (pair, "timestamp" DESC);
CREATE INDEX idx_update_pair_events_slot ON update_pair_events USING btree (slot);
