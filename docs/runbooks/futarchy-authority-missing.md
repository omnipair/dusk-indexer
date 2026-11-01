# Futarchy authority missing

## Recognise it

`/status` returns 503 with `degraded: ["futarchy-authority"]`, and
`futarchyAuthority.initialized` is `false`. In the app, every market launch
fails at its first step, "Preparing LP tokens", reading that address.

## Why it happens

The futarchy authority is the program's global account: it holds the protocol
authority and the fee recipients that `initialize_market` reads. An in-place
upgrade keeps it. A deploy to a new program ID starts with no accounts, so the
authority has to be created again. On 2026-11-01 devnet moved to a new program
ID without it, and market creation failed until it was created by hand.

## What it breaks

Market creation only. Reads, and trading on markets that already exist, are
unaffected; a fresh program has no markets yet.

## Do

1. In `dusk`, with the program's upgrade authority as `ANCHOR_WALLET` and the
   new program's IDL built, run
   `DUSK_PREVIOUS_PROGRAM_ID=<replaced program> yarn v2:ensure-futarchy-authority`.
   It copies the replaced program's authority, recipients and shares and
   reports any setting that came out different. Without
   `DUSK_PREVIOUS_PROGRAM_ID` the upgrade authority receives every share.
2. Only the upgrade authority can sign it: `init_futarchy_authority` checks the
   program's ProgramData.

`yarn v2:deploy-devnet` runs the same step after every deploy, so this should
only happen when a program is deployed some other way.

## Over when

`/status` drops `futarchy-authority` from `degraded`. A missing result is
re-read every 30 seconds.
