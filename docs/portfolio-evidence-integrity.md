# Portfolio evidence integrity index

Every finalized account observation remains immutable source evidence. A bank is
scoped by the complete cluster/program/IDL/revision identity, account, slot and
state basis. Two different blockhash/state-hash pairs in that bank still halt
portfolio projection and reads, including an included archived revision.

Migration 063 adds a derived bank index. It locks evidence inserts while
backfilling all existing banks, then installs an AFTER INSERT statement trigger.
Replay, ordinary inserts, imports and ON CONFLICT batches all update the bank in
the same transaction as their source evidence. A unique bank key serializes
concurrent writers. Fingerprints are comparison anchors; they never select a
fork winner, authorize a position or determine a payout. Original observations
are retained even when they disagree.

Disagreement is monotonic. The bank's identity and anchor cannot be rewritten,
a true flag cannot be cleared, and deletion/truncation is refused. Rollback
removes both the new evidence and its derived change. Reads seek a partial index
of conflicted banks instead of joining and grouping all account evidence on
every request. This is not a TTL cache and needs no repair timer.

Portfolio evidence, owner checkpoints and owner income now insert in batches.
The caller still commits the complete source archive before attempting its
projection. Original slots, hashes, owner boundaries and income amounts remain
unchanged. A failed batch does not publish partial checkpoints.

## Evidence

The existing history, repair, retirement and attribution regressions retain
identical results. Additional actual-migration tests cover pre-existing
conflicts, multiple revisions/bases, multi-row conflicts, duplicate inserts,
concurrent writers, rollback and attempts to erase or alter a bank.
A 180,000-row isolated history measured 284 ms for the old guard and under 1 ms
for the indexed lookup; tests assert index use rather than a flaky time limit.

A session-only temporary index on production evidence measured the complete
252-point history read at 1,247 ms before and 134 ms afterward, with identical
complete response data. The indexed guard took 2.7 ms. Temporary index creation
took 1,278 ms and was rolled back; no production table was changed by that
benchmark. These are bounded measurements, not a latency guarantee.

## Rollout

1. Publish the exact merged backend images after CI, including both PostgreSQL
   and TimescaleDB 16/17 migration/integration gates.
2. Deploy the indexer image first so its canonical migration runner applies
   063. Verify the recorded migration checksum and compare every derived
   key/flag against the original full source grouping in one snapshot.
3. Deploy the API and projection-worker image. Confirm matching deployment
   identity, unchanged historical data, live streams and healthy workers.
4. Keep the approved keeper configuration and shadow signing mode unchanged.

Older API/worker code remains compatible with the additive index and trigger.
For an image rollback, retain the migration and all evidence; never erase a
conflict flag to restore availability. A disagreement requires investigation of
its retained source facts.
