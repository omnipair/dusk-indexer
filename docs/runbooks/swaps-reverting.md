# Swaps reverting

## Recognise it

Users report failed swaps with no obvious pattern. Logs show
`BrokenInvariant`, error 6047, thrown at
`programs/dusk/src/transitions/liquidity/hlp/engine.rs`.

## What it breaks

**This is a known open protocol defect, not an operational failure.** There is
no configuration that fixes it and nothing on this page will make it go away.

Measured on devnet: on a market with no user debt at all, about a quarter of
swaps revert. With a few hundred quote borrowed, about nine in ten. The same
check also blocks `backstop_liquidation_auction`, so the lending settler cannot
run while a position is under auction — which is every time it is needed.

The cause is a reserve-identity check that tolerates three atoms of drift. That
is the right bound for the three independently floored quantities its comment
describes, and the wrong bound for accrued interest, which grows with principal
and elapsed slots. The hLP vault carries debt of its own, so drift accrues even
when nobody has borrowed.

## Do

1. Confirm it is this and not something new — the error and the file are
   specific enough to be certain.
2. Reproduce and quantify, so the report carries numbers rather than
   impressions:

   ```bash
   node --experimental-strip-types scripts/devnet/repro_swap_reverts_intermittently.ts
   ```

   (in the `dusk` repository; it repays what it borrows and leaves the market
   as it found it.)
3. Reduce the blast radius by clearing outstanding debt, which moves the
   failure from constant back to intermittent:

   ```bash
   node --experimental-strip-types scripts/devnet/restore_market.ts
   ```

4. Escalate. This needs a program change and a redeploy.

## Over when

It is not over until the program is fixed. Do not close on a quiet hour — the
failure is intermittent by nature and a market that swapped fine ten times in a
row has told you nothing.

## Do not

Do not widen `MAX_CONCENTRATED_HLP_LIVE_DUST_ATOMS` to make it pass. The drift
is unbounded in principal and elapsed time, so every constant is eventually too
small; the identity has to account for accrual rather than tolerate it. A wider
constant converts a loud failure into a silent accounting error, which is
strictly worse.
