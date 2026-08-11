# Dusk account decoder boundary (Local Snapshot 0)

The account decoder is compiled against the same indivisible protocol identity
and vendored IDLs as transaction decoding. Startup validates each account as an
IDL struct and verifies its discriminator as
`sha256("account:<AccountName>")[0..8]`.

## Pinned account coverage

| Program declaration | Account | Discriminator | Minimum encoded bytes, including discriminator |
| --- | --- | --- | ---: |
| Dusk | `BorrowPosition` | `f38c148b20f37237` | 266 |
| Dusk | `FutarchyAuthority` | `aff7a0b68c80d3e2` | 395 |
| Dusk | `LeverageDelegation` | `313c1d17f3db10d6` | 142 |
| Dusk | `LeveragePosition` | `584e7c44e48122fb` | 220 |
| Dusk | `Market` | `dbbed53700e3c69a` | 2,857 |
| Dusk | `ParameterProposal` | `b3089a312241e8ea` | at least 235; strings and enum width are dynamic |
| Dusk | `ProposalSupport` | `cf864d24433f8494` | 209 |
| Dusk | `ReferralAccrual` | `23f61942aea03027` | 113 |
| Dusk | `ReferralPartner` | `ea36a99d8ebbe1d6` | 76 |
| Dusk | `YieldAccount` | `e9f17706020e6a9c` | 234 |
| Leverage delegate | `LeverageOrder` | `e8a22d946a6a2584` | 202 |

The delegate IDL additionally declares `Market`, `LeveragePosition`, and
`LeverageDelegation`. Their discriminators and layouts are identical to Dusk.
Anchor IDL account declarations include typed CPI inputs and do not prove owner
program provenance. The decoder classifies all four delegate declarations, but
tags those three shared layouts as `referenced_external_layout` and suppresses
delegate-owned product projections. Runtime dispatch always starts from the RPC
account owner, never from the discriminator alone. `LeverageOrder` is the only
delegate layout currently tagged `expected_program_owned`.

## Layout and raw-data behavior

All type forms in the account dependency closure are decoded directly from the
pinned IDL. Integer fields remain lossless decimal strings and raw u8 codes with
no formal IDL mapping use typed `Unknown(code)` fallbacks where interpreted.

Anchor accounts can be allocated to a maximum enum/string size. After decoding,
zero-filled allocation padding is accepted and its exact byte count is exposed.
A non-zero trailing byte is an ambiguous layout and is retained as a malformed
known account rather than silently ignored. Unknown discriminators, short data,
truncated fields, invalid tags, and malformed layouts preserve the complete raw
account bytes and SHA-256 data hash.

Each result carries:

- `(cluster, program_id, idl_hash, protocol_revision)`;
- account pubkey and data hash;
- slot, blockhash, parent slot, and commitment;
- optional transaction signature and write version;
- observation timestamp and source.

The envelope rejects missing fork identity, invalid account/signature values,
empty sources, and unpinned owner programs.

## Typed projections

The account projection layer is separate from decoded JSON and never maps into
legacy `Pair`, `token0/token1`, or `UserPosition` models.

- Market discovery exposes the market pubkey, yLP and per-side asset/hLP/vault
  topology, reserves/supply, curve and risk revisions, freshness slots, prices,
  reduce-only state, and all eight per-side protocol-auction lanes.
- Executable AMM kind comes from `amm.applied_curve_parameters`. The separate
  configured kind comes from `config.amm`, because governance/ramp parameters
  may not yet be admitted by the protected-profit gate.
- Portfolio projections cover borrow and leverage positions, delegations,
  delegate orders, proposal locks, referral registry/accruals, and yield ledgers.
- Keeper discovery covers borrow and leverage liquidation inputs, TP/SL order
  inputs, parameter-proposal execution windows, protocol-auction lanes, and the
  two global auction configurations.

Keeper records are discovery hints only. Keepers must directly refetch all joined
accounts under the same protocol identity, rebuild protocol math, simulate, and
revalidate immediately before submitting.

## Persistence and replay blockers

1. Migration 018 stores event observations only. Account observations need
   identity-scoped raw snapshots, canonical pointers, write ordering, and
   tombstones. Confirmed fork replacement must transactionally rebuild dependent
   projections; finalized account state must be immutable under reconciliation.
2. Current `AccountUpdate` metadata lacks blockhash, parent, commitment, and
   write version. RPC program subscription also omits deletions. Pubsub can only
   be a discovery hint until a confirmed RPC reconciliation supplies fork-grade
   facts and deterministic ordering for multiple writes in one slot.
3. The delegate declares zero events. Order create/update/cancel/after-close and
   account deletion are its lifecycle, so TP/SL replay requires canonical account
   tombstones or persisted canonical instructions.
4. `YieldAccount` stores entitlement checkpoints/accruals, not wallet yLP/hLP
   balances. Portfolio balances require SPL and Token-2022 account/mint ingestion.
5. The API contract must decide how cross-program portfolios represent identity.
   A Dusk identity cannot silently contain delegate-order state; use separate
   envelopes or an explicit multi-program bundle identity and cursor contract.
6. Captured Surfpool fixtures are still required to validate real account owner,
   allocation size—especially `ParameterProposal`—deletion behavior, block/fork
   reconciliation, and replay idempotency.

Do not persist projections until these gates are resolved. Realtime, backfill,
and replay must call the same pinned decoder and canonical-write path.
