# Program upgraded

## Recognise it

The daemon logs the loader transaction and continues indexing under the
vendored event revision. The API does not read the program from chain: its
envelope reports the deploy slot and binary hash recorded in
`protocol/compatible-deployment.json` until that file is updated. Check
`/api/dusk/v1/status` for cursor freshness; a program upgrade alone should not
make it stale.

## What it breaks

An IDL or account-layout change can require a new decoder revision. Keepers
still verify the protocol directly before submitting transactions. The indexer
does not infer that a new binary has the same IDL merely from its hash.

## Do

1. Confirm what is actually deployed:

   ```bash
   solana program show <PROGRAM_ID> -u devnet
   ```

2. If instructions, events or accounts changed, vendor the new Dusk IDL and
   revise the indexer identity. In `dusk-keepers`, regenerate the contracts:

   ```bash
   node scripts/generate-instruction-contract.mjs --write
   node scripts/generate-adapter-codecs.mjs --write
   node scripts/generate-account-layout.mjs --write
   node scripts/compute-worktree-fingerprint.mjs ../dusk --write
   npm run check && cargo test
   ```

3. Read the diff before committing it. A changed discriminator means an
   instruction was renamed or its signature changed; a changed offset means an
   account gained or lost a field. Both are things a keeper acts on, and
   regenerating without reading is how drift gets laundered into a commit.
4. For a compatible upgrade (same IDL and event revision), record the new
   executable in `protocol/compatible-deployment.json`: `deploySlot` and
   `allocatedBinaryBytes` from `solana program show`, and `binarySha256` of
   the dumped program. Redeploy the API and workers so envelopes and capture
   provenance carry it.
5. Deploy updated consumers only if their IDL or account contract changed.

## Over when

The indexer cursor continues advancing, `/status` is healthy, and any required
consumer rebuild passes its checks.

## Do not

Do not reuse an event revision after changing the IDL hash. Replay and review
the new event layout before activating a different decoder.
