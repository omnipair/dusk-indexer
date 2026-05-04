-- Migration: Add slot indexes to swaps and adjust_liquidity
-- Purpose:
--   The GeckoTerminal Integration API (/api/v1/gecko/events) is polled every
--   ~2 seconds with `fromBlock`/`toBlock` ranges expressed as Solana slots.
--   Without a btree index on `slot`, the indexer's range queries do a full
--   chunk scan because the existing TimescaleDB hypertables are partitioned
--   by `timestamp`, not slot. These indexes are created per-chunk by
--   TimescaleDB and dramatically reduce the per-poll cost.
--
--   `CREATE INDEX CONCURRENTLY` keeps the tables writable while building.
--
-- Notes:
--   - swaps.slot is BIGINT, adjust_liquidity.slot is NUMERIC. Both are still
--     btree-indexable; the index uses the column's native ordering.
--   - update_pair_events.slot already has an index from migration 008.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_swaps_slot
  ON swaps (slot);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_adjust_liquidity_slot
  ON adjust_liquidity (slot);
