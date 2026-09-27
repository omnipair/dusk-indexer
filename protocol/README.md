# Dusk devnet protocol pin

`protocol.lock.json` is the active decoding and deployment identity. It pins
both Dusk and leverage delegate to Solana devnet, including genesis, program IDs,
binary hashes, raw IDL hashes and canonical IDL hashes.

`dusk-indexer-foundation::verify_vendored_protocol` verifies the vendored files.
Never hand-edit generated IDLs. A protocol upgrade vendors a new revision, runs
replay/reconciliation checks, and deliberately switches the active identity.
The legacy Omnipair decoder cannot decode Dusk accounts or events.

The current pin is `devnet-2026-09-27-5644e5d`, built from Dusk PR #40
(`5644e5db86d63311b35b8373992f8fa210ef3ccf`). Dusk was upgraded at
finalized slot 504809896; the unchanged leverage delegate remains at slot
497831834. The Dusk binary was dumped at finalized commitment and matched
the tested build byte for byte. Evidence and the previous pin are in
`docs/evidence/devnet-20260927-5644e5d/` and `protocol/archive/`.

The generated IDL adds post-swap price, EMA and growth snapshots, asset
decimals in `MarketCreated`, and lifecycle events. Account layouts are
unchanged. The deployment-scoped SDK package is `2.10.2-devnet.20260927`:
it carries this Dusk IDL and the unchanged deployed delegate IDL. Historical
observations retain their original identities; new captures, projections and
cursors use the new revision without relabeling old records.
