# Keeper wallet drained

## Recognise it

The keeper's `/healthz` reports an `executionError` naming the lamport floor:

```
signer holds 4200000 lamports, below the 20000000 floor
```

The keeper stops acting but stays up and keeps discovering. That is deliberate:
a keeper that exits on an empty wallet loses the observation that would tell
you it is empty.

## What it breaks

Whatever that profile does. The lending trigger stops opening auctions; the
bidder stops filling them; the settler stops calling the backstop. Positions
that need liquidating do not get liquidated, and the protocol carries the risk
until somebody does.

Profiles are separate services with separate wallets precisely so this is not
all of them at once. A drained bidder does not stop the trigger.

## Do

1. Read the signing address from the keeper's startup log
   (`keeper signer=...`), or from `/healthz`.
2. Fund it. On devnet:

   ```bash
   solana airdrop 2 <SIGNER> -u devnet
   ```

3. The keeper picks it up on its next pass. No restart is needed — the floor is
   checked per pass rather than at startup, because a keeper that has been
   running for a week is exactly the one that has spent its SOL.

## Over when

`executionError` is null and `evaluated` climbs again on `/healthz`.

## Do not

Do not raise `KEEPER_MINIMUM_LAMPORTS` to get past the floor. The floor exists
so a keeper stops before it discovers mid-liquidation that it cannot pay, which
leaves a position half-handled.

Do not reuse one wallet across profiles to simplify funding. One wallet per job
is what keeps a drained or compromised bidder from stopping liquidations being
triggered.
