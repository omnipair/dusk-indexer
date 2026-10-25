# Dusk devnet protocol pin

`protocol.lock.json` records the original deployment and the active decoding
identity. It includes the devnet genesis, program IDs, original binary hashes,
raw IDL hashes and canonical IDL hashes. Later executable upgrades under the
same program IDs and IDL revision do not require a new binary pin.

`dusk-indexer-foundation::verify_vendored_protocol` verifies the vendored files.
Never hand-edit generated IDLs. A protocol upgrade vendors a new revision, runs
replay/reconciliation checks, and deliberately switches the active identity.
The legacy Omnipair decoder cannot decode Dusk accounts or events.

The current pin is `devnet-2026-10-25-296263d`, built from Dusk PR #45
(`296263d0f4f34478b2701c32e337550a26aa3c4b`). Dusk was upgraded at
finalized slot 515007663 and leverage delegate at slot 515001929. Both
ProgramData accounts were dumped after deployment and matched the tested
binaries byte for byte. After the devnet market and vault reset, the reviewed
Dusk binary was restored at slot 515039667. Its 3,493,688 artifact bytes match
the on-chain executable prefix exactly; the larger ProgramData allocation ends
with 24,864 zero bytes retained from the temporary cleanup upgrade.
`compatible-deployment.json` records the full dumped executable without moving
the event revision's original boundary. The
preceding `devnet-2026-09-27-5644e5d` decoder is preserved under
`protocol/archive/` for immutable historical reads.

This revision includes the flash and emergency liquidation interfaces,
position principal accounting, reusable governance support, leverage position
actions, hLP recovery/yield accounting, and their lifecycle events. The
deployment-scoped SDK package is `2.14.2-devnet.20261025`. Historical
observations retain their original identities; new captures, projections and
cursors use the new revision without relabeling old records.
