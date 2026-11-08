# Junior exit and preview-layout release candidate

Both programs from Dusk PR #78 commit `c5993da973f932d270714afea588fc5bc981a242`
are deployed on devnet. `candidate.json` records the finalized slots, payload and
allocated binary hashes, unchanged authorities, and generated IDL hashes. The
IDL files are copied directly from that tested Anchor build.

This is an **inactive candidate**. The active protocol lock, history boundary,
SDK dependency and quote runtime are unchanged. SDK `2.19.0-next.20261109` must
first be published through the program repository's workflow after its required
independent review. Use the real registry artifact to prepare the dependency
lock and SDK hash; do not substitute a local tarball for a published release.

The live market-loading failure is a decoding mismatch. Dusk PR #76 removed
`PreviewSide.rate_at_target_nad`, shortening each preview side by 16 bytes. The
active indexer still uses the previous layout. The saved unsigned preview at
slot `520140408` decodes with the candidate as base debt `119799095` and quote
debt `70357193` in native units. The previous decoder instead reads
`21852238946991005566376853399` and `1892600565371`. Its resulting hLP leverage
estimate makes the frontend reject the markets response. Hiding the estimate
would retain the incorrectly decoded debt and utilization.

Before activation:

1. Install and verify the exact published SDK artifact.
2. Archive the current lock, IDLs, price references and quote runtime under
   `devnet-2026-11-06-operators`; preserve its observations and cursors.
3. Promote a new revision with the finalized deployment evidence and matching
   quote-runtime payload and allocation hashes. Regenerate dependent keeper
   contracts from the generated IDLs.
4. Run decoder replay/compatibility checks, API and database integration tests,
   and quote-runtime parity checks before deploying the indexer and consumers.
5. Update the frontend's published SDK and identity pins, then verify live reads
   and the dedicated-wallet cancel/increase/decrease write path.

The fixture contains public return data from a read-only simulation. No key,
wallet signature, or submitted transaction is included.
