# Dusk devnet protocol pin

`protocol.lock.json` is the active decoding and deployment identity. It pins
both Dusk and leverage delegate to Solana devnet, including genesis, program IDs,
binary hashes, raw IDL hashes and canonical IDL hashes.

`dusk-indexer-foundation::verify_vendored_protocol` verifies the vendored files.
Never hand-edit generated IDLs. A protocol upgrade vendors a new revision, runs
replay/reconciliation checks, and deliberately switches the active identity.
The legacy Omnipair decoder cannot decode Dusk accounts or events.

The current pin is `devnet-2026-09-18-1fa72d3`, built from merged Dusk PR #30
(`1fa72d35973efedd47a157775cdd0d1ef3ae90d9`). Dusk was upgraded at finalized
slot 499930981; the unchanged leverage delegate remains at slot 497831834.
Both upgrade authorities are unchanged. The complete ProgramData payload was
read back and compared with the zero-padded tested build. Evidence and the
previous pin are retained in `docs/evidence/devnet-1fa72d3/`.

The generated IDL adds `preview_borrow_position_capacity`. Existing instruction
signatures, account layouts, types, events and errors are unchanged. The SDK is
2.8.0. Historical observations retain their original identities; new captures,
projections and cursors use the new revision without relabeling old records.
