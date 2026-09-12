-- Dusk event time-series, the v1-parity surface for charts and history.
--
-- The dusk_ingestion foundation stores observations keyed by protocol
-- identity for correctness; this table is the read-optimized projection of
-- the same events onto a Timescale hypertable, one row per canonical event,
-- keyed by block time — the same shape v1 gave swaps and pair updates.

CREATE TABLE IF NOT EXISTS dusk_ingestion.event_stream (
    time TIMESTAMPTZ NOT NULL,
    cluster TEXT NOT NULL,
    program_id TEXT NOT NULL,
    event_name TEXT NOT NULL,
    -- Most Dusk events carry the market they concern; extracted for the
    -- dominant query axis. NULL for the few market-less events.
    market TEXT,
    transaction_signature TEXT NOT NULL,
    event_key TEXT NOT NULL,
    slot BIGINT NOT NULL CHECK (slot >= 0),
    payload JSONB
);

-- Hypertable where Timescale is installed (production); a plain table
-- otherwise, so a stock-postgres dev box can still run the full pipeline.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
        PERFORM create_hypertable(
            'dusk_ingestion.event_stream',
            'time',
            chunk_time_interval => INTERVAL '7 days',
            if_not_exists => TRUE
        );
    ELSE
        RAISE NOTICE 'timescaledb is not installed; dusk_ingestion.event_stream stays a plain table';
    END IF;
END
$$;

-- Idempotent ingestion: a hypertable's unique index must include the
-- partitioning column, so the event key is deduplicated per (key, time) —
-- one canonical event only ever has one block time.
CREATE UNIQUE INDEX IF NOT EXISTS dusk_event_stream_key_time_idx
    ON dusk_ingestion.event_stream (event_key, time);

CREATE INDEX IF NOT EXISTS dusk_event_stream_market_time_idx
    ON dusk_ingestion.event_stream (cluster, market, time DESC);

CREATE INDEX IF NOT EXISTS dusk_event_stream_name_time_idx
    ON dusk_ingestion.event_stream (cluster, event_name, time DESC);

CREATE INDEX IF NOT EXISTS dusk_event_stream_signature_idx
    ON dusk_ingestion.event_stream (transaction_signature);
