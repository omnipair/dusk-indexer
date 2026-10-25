# Dusk devnet protocol pin

`protocol.lock.json` records the original deployment and the active decoding
identity. It includes the devnet genesis, program IDs, original binary hashes,
raw IDL hashes and canonical IDL hashes. Later executable upgrades under the
same program IDs and IDL revision do not require a new binary pin.

`dusk-indexer-foundation::verify_vendored_protocol` verifies the vendored files.
Never hand-edit generated IDLs. A protocol upgrade vendors a new revision, runs
replay/reconciliation checks, and deliberately switches the active identity.
The legacy Omnipair decoder cannot decode Dusk accounts or events.

The current pin is `devnet-2026-10-26-cd6f1ec`, built from Dusk PR #45
(`cd6f1ec0e074082b9c191b0ec741477037aa9eb3`). Dusk was upgraded at
finalized slot 515117115 and leverage delegate at slot 515117216. The first
slot for the complete revision is 515117217. No market creation or service
deployment is part of this protocol-pin update.

The dumped Dusk executable contains the 3,507,624-byte tested payload
(SHA-256 `b0f04cd524f967df97abc4d73c5b0ab8a8f17f1204ab1aa4b9054152e344ed78`)
followed by 10,928 zero padding bytes. Its complete 3,518,552-byte allocation
hashes to `203c20214aa1ea2b624207a88606bc10ba7c0d5b36fd9171d89081627cfc43f1`;
the lock and `compatible-deployment.json` pin that complete executable. The
1,149,896-byte delegate dump matches the tested payload exactly, with SHA-256
`4c1f7e1b326ff91d34d87edc888dee38bfde44058be50df3bb7ecdbe11845e1f`.

The preceding `devnet-2026-10-25-296263d` lock, generated IDLs, compatible
deployment metadata and price references are preserved under
`protocol/archive/` for immutable historical reads. Earlier decoding revisions
remain there as well.

This revision includes the flash and emergency liquidation interfaces,
position principal accounting, reusable governance support, leverage position
actions, hLP recovery/yield accounting, and their lifecycle events. The
deployment-scoped SDK package is `2.14.2-devnet.20261025`. Historical
observations retain their original identities; new captures, projections and
cursors use the new revision without relabeling old records.

The generated Dusk IDL now includes liquidation post-state events and
mint-specific hLP cohorts. The active IDL and vendored SDK have matching
canonical interfaces. The SDK archive SHA-256 is
`186c3d85c5a733da446c6f00301fefd0f36170336f1d8f4fdc9807ffc8c16d8c`.
Fresh cursors start under the new protocol identity; existing observations keep
their recorded revisions and source bytes.
