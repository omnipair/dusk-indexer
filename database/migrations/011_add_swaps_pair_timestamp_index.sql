-- Migration: Add composite index on (pair, timestamp) to swaps
-- Purpose:
--   Optimize queries that filter by pair and scan a timestamp range,
--   such as candle aggregation, price charts, swap volume, and fee queries.
--   Without this index, these queries use the pair-only index and then
--   filter timestamps in a separate step. With it, they do a single
--   efficient index range scan.
--
--   On a TimescaleDB hypertable this index is created per-chunk automatically.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_swaps_pair_timestamp
  ON swaps (pair, "timestamp" DESC);
