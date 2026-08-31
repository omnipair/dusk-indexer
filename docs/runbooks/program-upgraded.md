# Program upgraded underneath the deployment

## Recognise it

Every service refuses to start, or `deploymentIdentitySha256` on `/status`
changes without a deploy on this side. Keepers refuse a protocol lock whose
revision does not match their generated account layout.

This is the failure the pinning exists to catch, so loud refusal is the system
working. The dangerous version is the one where nothing complains and a keeper
sends an instruction the program no longer has — which is what happened before
the contract was regenerated against the deployed IDL, and why the generators
are run by the validator now.

## What it breaks

Everything that signs, immediately and by design. Reads keep working until the
account layouts change under them, at which point they return nonsense rather
than failing — which is why the layout carries an exact size for every account
that has one.

## Do

1. Confirm what is actually deployed:

   ```bash
   solana program show <PROGRAM_ID> -u devnet
   ```

2. In `dusk-keepers`, re-pin and regenerate everything derived from the IDL:

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
4. Redeploy the keepers, then the API.

## Over when

`npm run check` passes, `/status` reports the new
`deploymentIdentitySha256`, and every keeper reaches `ready`.

## Do not

Do not widen a check to make a service start. Every one of them is refusing
because it cannot prove it is talking to the program it was built against.
