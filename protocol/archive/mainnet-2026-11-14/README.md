# Mainnet layout-17 historical decoder

The lock and both IDLs are byte-identical copies of the active mainnet-2026-11-14 history pin at preparation time. They preserve the deployed 0acc9057 source identity and original history boundary. Registration is checked against the lock hash in protocol/history-revisions.json and both vendored IDL hashes.

These artifacts support read-only access to stored history. They do not authorize new captures, quotes, replay under the active decoder, transaction preparation or live signing. Historical valuations and observations retain their original protocol identity; the new SDK never reinterprets these account bytes. Retain the corresponding verified binaries and runtime/release evidence in the release archive before upgrading.
