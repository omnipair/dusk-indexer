# Dusk devnet protocol pin

`protocol.lock.json` is the active decoding and deployment identity. It pins
both Dusk and leverage delegate to Solana devnet, including genesis, program IDs,
binary hashes, raw IDL hashes and canonical IDL hashes.

`dusk-indexer-foundation::verify_vendored_protocol` verifies the vendored files.
Never hand-edit generated IDLs. A protocol upgrade vendors a new revision, runs
replay/reconciliation checks, and deliberately switches the active identity.
The legacy Omnipair decoder cannot decode Dusk accounts or events.

The current pin is `devnet-2026-09-13-9973dea`. Merged main has the same source
tree as the tested a45b788 artifacts. Dusk and leverage delegate were upgraded
and their complete ProgramData payloads verified at finalized slots 497831403
and 497831834. Both upgrade authorities are unchanged. Public read-back evidence
and transaction signatures are in the sibling keeper repository at
`artifacts/releases/devnet-9973dea/`. Historical observations retain their
original revision; no historical local-validator snapshot is used by the runtime.
