# Fresh devnet release

Program source `2b6311f4b4f8c1678edee72e8a3dbd1ff3f467b5` is deployed under
fresh Dusk/delegate IDs by [dusk#86](https://github.com/omnipair/dusk/pull/86).
SDK `2.21.0-next.20261109` is published with provenance; its verified archive
SHA-256 is `645f872b2d786195f9153f5b784776159400ec7ca6d735d442875be70e9b7116`.

The complete revision starts at slot **520350150**. Both markets were created
after that boundary, at 520351094 and 520351278, and both have funded junior
tranches. Canonical replay processed 43 transactions with 21 events and no
failures. The production wallet-balance service returns the exact on-chain
senior and junior holdings; see `fixtures/ownership.json`. No account migration,
ownership bootstrap, copied observations or reused old cursor is involved.

`deployment.json` records the finalized binaries, both uploaded IDLs and
32.17886376 SOL reclaimed from the previous program-data/IDL accounts.
The prior complete tuple, source bytes, runtime and observations retain their
`devnet-2026-11-09-combined-layout14` identity under `protocol/archive`.

Native acceptance covers cancellation during notice, atomic larger/smaller
replacement, the full crowding-adjusted notice, unchanged junior capital and
senior holdings until conversion, and rejection of overwrite, zero renewal and
early conversion. Request fees remain paid after cancellation.

Four native maximum-leverage fixtures cover both market forms and debt sides;
every selected transaction is independently accepted by fresh devnet RPC under
the 1.4M-CU execution ceiling. Current virtual-book and streamed swap fixtures
retain their actual fresh-program identity and source slots. Historical fixtures
remain unchanged.
