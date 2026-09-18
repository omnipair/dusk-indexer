BEGIN;

-- Replay and pending-history checks join on observation_id. The checkpoint
-- primary key starts with protocol identity and cannot serve this lookup.
-- Without this index, a newly activated revision with stale statistics can
-- choose a nested-loop anti join that rescans all historical checkpoints for
-- every observation and exhausts the worker's statement timeout.
CREATE INDEX dusk_yield_checkpoint_source_lookup
  ON dusk_ingestion.yield_checkpoints(observation_id);

-- Keep bounded replay in source-slot order while retaining discovery of late
-- observations. A high-water cursor would silently skip old-slot backfills.
CREATE INDEX dusk_yield_checkpoint_replay_order
  ON dusk_ingestion.yield_checkpoint_observations
    (cluster,program_id,idl_hash,protocol_revision,slot,observation_id);

COMMIT;
