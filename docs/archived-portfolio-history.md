# Portfolio history across protocol releases

Portfolio history reads may include previously persisted checkpoints from the
explicit releases in `protocol/history-revisions.json`. Each entry pins the raw
SHA-256 of its archived `protocol.lock.json`; that lock verifies both archived
IDLs before the release is eligible. The current mainnet layout-17 lock and
IDLs are preserved byte-for-byte under `protocol/archive/mainnet-2026-11-14`.

The active identity and archive must share the exact cluster, genesis and both
program IDs. Every point keeps its original cluster, program ID, IDL hash,
protocol revision, slot range, source hash and deployment identity. Old rows
are neither relabeled nor decoded with the active IDL. An archive with the
current identity is deduplicated; a conflicting pin, corrupt file, unregistered
revision or cross-network/program release is rejected.

The registry is read-only application configuration, not an HTTP parameter.
It does not authorize old observations for ingestion, replay, capture, quotes,
price repair or keeper signing. Those paths retain the active pin and their
existing identity guards. Finalized contradictions are checked within each
included full identity and halt reads; different identities are never treated
as one bank. Pagination, range filters, valuation repairs and gap-preserving
sampling continue to operate on immutable stored checkpoints.

During the layout-19 rollout, retain this archive and add any separately
verified temporary retirement release only after recording its actual IDLs,
deployment interval and lock. Switching to the new active pin still requires
the published stable SDK, verified programs and full release gates. The webapp
history validator must explicitly register the same historical identity before
that switch; it must not weaken the active identity checks for trading. This
change alone performs no migration, backfill, deployment or publication.
