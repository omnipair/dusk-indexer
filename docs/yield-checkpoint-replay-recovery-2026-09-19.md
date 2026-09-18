# Yield checkpoint replay timeout

The devnet `dusk-yield-checkpoints` service captured 14 accounts after the
realtime merge deployment, then exited repeatedly at approximately 30-second
intervals. The old catch handler discarded the underlying error code.

## Cause

Replay selects observations that have no matching checkpoint using
`p.observation_id = o.observation_id`. The foreign key had no supporting index;
the checkpoint primary key begins with protocol identity and yield account.
On the live database, stale statistics estimated one current-revision observation
instead of 798. PostgreSQL selected a nested-loop anti join whose inner side
rescanned the entire roughly 41,000-row checkpoint table for each observation.
The pool's statement timeout is 30 seconds. A read-only reproduction with a
five-second limit also failed with SQLSTATE `57014` after 5,005 ms.

## Repair

Migration `041_dusk_yield_checkpoint_replay_indexes.sql` adds the missing
checkpoint lookup index and an identity/slot/observation index for ordered
source discovery. Replay still finds older observations inserted later; no
high-water cursor, discarded evidence, increased timeout or relaxed invariant
is used. The worker now reports a bounded error code and its startup/replay/
capture phase, without printing database or RPC messages containing credentials.

The migration was applied to the devnet database through the existing API
container's database connection, with the canonical migration advisory lock,
a five-second lock timeout and a 30-second statement timeout. Index creation
and the canonical SHA-256 ledger entry committed together in 458 ms. Existing
observations and projections were not changed.

Migration checksum:
`81f0885d79ca4dda362cf8ac961b68ff37980b6416d677f69e84ca82112b99b9`.

## Validation

- All 159 API unit tests and the TypeScript build passed.
- All 20 yield-checkpoint, yield-claim and yield-rate integration tests passed
  against a separate local database. These cover old-slot replay, idempotency,
  contradictory finalized evidence, ownership and deployment isolation.
- The complete canonical migration manifest applied to an empty local database;
  a second run skipped the recorded migrations without errors.
- The unchanged live replay query returned zero pending observations in 15 ms.
  `EXPLAIN (ANALYZE, BUFFERS)` measured 2.035 ms, using both new indexes with
  2,619 shared buffer hits and no full checkpoint-table scan. It still examined
  all 798 observations in the active deployment.

This is an indexer/database repair. No Solana transaction was signed or submitted.
