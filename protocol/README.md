# Dusk protocol pin

This directory is copied byte-for-byte from the keeper repository's Local
Snapshot 0. It is the only accepted decoding identity for this indexer stage.

| Program | Program ID | IDL SHA-256 |
| --- | --- | --- |
| Dusk | `358bjJKXWxeAXAzteX1xTgyd9JNnjtzW8fnwCS8Da1mv` | `5e67579b6dbec5620a5578844cd56c44458a3167095d8db2e85fd76643d5473f` |
| Leverage delegate | `EPGF9iFrbGnhWgC3To9rC9vxinEYuDHaz4RXgLPvuRkp` | `948b9475071daa318cbc9f0e3cc2f8d150191a4ec3dc54e63a661ea489cc5f4a` |

Protocol revision: `local-snapshot-0`.

`dusk-indexer-foundation::verify_vendored_protocol` verifies both IDL bytes and
the matching entries in `protocol.lock.json`. Never hand-edit an IDL. A protocol
upgrade vendors a new revision, runs replay/reconciliation, then deliberately
switches the active identity.

The legacy `carbon-omnipair-decoder` is not compatible with these artifacts.
It must not be used to decode Dusk accounts or events.
