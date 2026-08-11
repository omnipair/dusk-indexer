# Dusk indexer invariants

- Treat `(cluster, program_id, idl_hash, protocol_revision)` as one indivisible
  identity. Refuse startup, cursor reuse, decoding, or API mixing when any field
  differs from the vendored protocol lock.
- Never hand-edit generated IDLs. A changed IDL hash creates a new protocol
  revision and requires replay plus compatibility review before activation.
- Persist observations before projections. The canonical event key is protocol
  identity + transaction signature + complete instruction/CPI path + event
  ordinal; slot and commitment are observation attributes, not identity.
- Do not select a fork winner from arrival order or slot height. Store both
  observations, reconcile against RPC, and transactionally roll back projections
  before moving a confirmed canonical pointer. A finalized canonical observation
  is immutable; contradictory finalized data is a halt condition.
- Realtime, replay, and backfill must use the same decoder and idempotent
  canonical-write path. Cursors are scoped to protocol identity and commitment;
  reconciliation must cover gaps before a range is reported complete.
- Keepers may use indexer data to discover candidates, but must re-fetch state,
  rebuild/simulate the transaction, and verify the protocol identity through a
  direct RPC immediately before submission.
- Do not map Dusk into legacy `Pair`, `token0/token1`, dual-yLP, or direct
  liquidation assumptions. New projections derive only from the pinned Dusk IDL
  and explicit product contracts.
