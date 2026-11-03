# Senior LP naming

The senior receipt is `srLP`, paired with `jrLP`. API responses expose `srlp`
LP kinds, `srlpMint`, `baseSideSrlpSupply`, `quoteSideSrlpSupply`,
`baseHlpSrlpVault`, `quoteHlpSrlpVault`, `governanceLockedSrlp`, and `eligibleSrlp`.
The hLP rate basis is `leveraged-recorded-srlp-net-of-funding.v1` with
`srlpGrowth`. Portfolio, ownership, yield, governance and streamed projections
use the same naming. SDK types come from `2.17.0-next.20261104-srlp`.

Migration `052_dusk_senior_lp_names.sql` normalizes payload field names in
read projections and updates all dependent LP balances, governance, yield and
compatibility views. Existing observations, raw bytes, hashes, protocol
identities, migration checksums and scan evidence remain immutable. Older
capture kinds remain valid evidence and project to `srlp` on read. No stored
historical event is relabeled as a new IDL revision.

The candidate bundle is
`protocol/candidates/next-2026-11-04-senior-lp/`. Its IDLs are copied from the
Anchor build, and its SDK archive is identical to the frontend archive. The
active deployment pin remains the previously verified release; runtime SDK
selection continues to require exact canonical IDL equality. Historical raw
fields are adapted only after decoding through their pinned schema. The
`hlp_ylp_vault` address seed remains stable and matches the renamed program
and SDK constants.

The candidate requires deployment verification, replay compatibility review
and explicit active-pin promotion before the matching frontend can transact.
This source PR does not claim a deployment or change existing token metadata.
