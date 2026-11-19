# Coordinated mainnet retirement and accrued-interest upgrade

Preparation status: 19 November 2026. Program #113 and #117 are merged after
owner-approved administrator overrides. Signed main is
`aa196e3423fd5f46b00630a4f161d91f95ef7b3d`; its source tree exactly matches the
checked combined candidate. Final-commit unsigned release builds are separate
from that source approval. No mainnet execution, publishing, authority transfer,
keeper activation or market creation is authorized by this document.

## Fixed release decisions

- Keep Dusk `DuskWhswJYrzABDn8GqQD191X9RobRi5jhgGntXEdnKj` and delegate
  `DeLegABhDLREbDpwwcsbkHvDS5MwqKPAw1CJKoooUXFQ`.
- Retire layout-17 OMFG/META
  `7xf68VEvMtLJ2Up5zVZdA161uH1yNkTFYgDFhNUSwkM7` before replacing its normal
  account/exit implementation. Reduce-only alone cannot preserve that exit path.
- Include forced settlement with final net OMFG/META, the existing curve and
  normal fees. Each token payout must be at least the integer ceiling of 99%
  of its reviewed quote. No treasury top-up or original-deposit guarantee.
- Permit immediate terminal junior settlement once frozen and all loans,
  leverage and hLP funding are cleared, retaining the 0.5% junior exit fee.
- Reconcile every user/operator/fee claim first. Only then send permanent seed,
  protocol fees and rounding residual to
  `8s6Jdoh7tgUqmU3D2EmpNJHSvuN5U4NybpLAdsiMitwB`.
- Include #113's documented issuer-controlled asset extensions. The owner
  accepted those issuer risks on 19 November; the private audit remains private.
  Acceptance does not waive regression tests or allow active asset transfer hooks.
- Keep the checked encrypted-volume deployer as the initial program and IDL
  authority. Squads handoff is later. Keep all six KMS workers in SHADOW.
- Users create replacement markets through the UI; the release creates none.

The recorded active release is layout 17, revision `mainnet-2026-11-14`, SDK
`2.27.0`, derived from program source `0acc9057b53a0495571f1bbf8a18e5db0f2efd45`.
Read back actual code, IDLs and authorities before signing. SDK `3.0.1` is the
combined extension/accrued-interest candidate, unpublished until the protected
publisher verifies the final normal deployment. Never invent registry integrity.

The refreshed 19 November economic bank at slot 471003239 contains 97 coupled
protocol/token accounts, five leverage positions, two loans, six beneficiaries,
18 yield accounts and two junior-exit accounts. Seven plain System-wallet SOL
balances are observed separately and explicitly labeled; no financial state is
split across banks. Discovery found an additional funded LP holder after the
original five-wallet capture, so the temporary scope and ordered payout-evidence
root now cover six wallets and 28 personal accounts. These are dated preparation
counts, not final payouts. Recapture after the actual freeze and reject any new
unreviewed financial account or beneficiary.

## Preparation and release artifacts

| Component | Candidate | Required evidence before activation |
| --- | --- | --- |
| Normal programs | Merged #112, #114/#116, #113 and #117; normal production profile | Final combined signed main commit; exact production binaries and both IDLs |
| Temporary retirement | Merged program #117, isolated `production,legacy-retirement` | Separate exact-source reproducible bundle and frozen native replay; no SDK publication |
| SDK | Stable `3.0.1` candidate | Protected GitHub publisher; both final binaries, IDLs and authorities match |
| Indexer/API | #99 decoder, #100 API cutover, merged #102/#103 inventory/rehearsal, #104 historical reader and #105 atomic growing catalog; #106 verified empty portfolios | Published SDK, frozen complete identity, exact quote runtime, replay and retired-market projections |
| Webapp | merged #239 extension admission and #250 portfolio archive validator; draft #240 accrued-interest port | Coherent published SDK/API identity and all application gates |
| Keepers | Existing separate AWS KMS keys and SHADOW workers | New captured mainnet lock, release matrix, simulation, lease and reconciliation gates |

Merges prepare source; they are not evidence that an on-chain deployment passed.
The normal and retirement bundles are different build profiles. Never substitute
ordinary Anchor/devnet output for either reproducible release artifact.

## 1. Complete the preparation gates

1. Synchronize the candidate PRs with current main, review combined behavior and
   pass full required local/GitHub tests. Test both flash routes and every
   temporary Token-2022 vault with the captured public USDv fixture. Retain
   legacy accounting regressions independently from layout-19 fixtures.
2. Build the temporary Dusk-only bundle and the normal two-program bundle from
   their final signed source. Record full commits, builder, arguments, hashes,
   generated IDLs, intended authorities and immutable artifact locations.
3. Rehearse the temporary lifecycle against a finalized legacy bank. Check
   incomplete batches, receipts/supply, review delays, burns, donations, unsafe
   recipients, second-leg rollback, duplicate transactions, restart, stale
   freezes and old-binary rollback. Native tests must consume exact artifacts.
4. Prepare backend retirement observations, terminal portfolio handling, archive
   lineage and frontend retired-market behavior. Existing historical captures
   remain under their original full identity, never relabeled or re-decoded.
5. Review the concrete temporary release and current funding before requesting
   its execution window. Live-write checks remain unexecuted during preparation.

Program #117 attests fixed economics computed by the exact old executable; it
is not an on-chain implementation of every ordinary swap/repay instruction.
Governance remains responsible for the reviewed curve order, normal fees and
net manifest. On chain it enforces immutable funding, fixed beneficiaries,
complete personal-account groups, safe recipients and single-use payouts.

## 2. Authorized temporary upgrade and cutoff

1. Announce maintenance, stop public transaction preparation and quiesce all
   signing, simulation/capture and keeper workers. Reconcile pending signatures
   and allow old transactions to expire. Preserve raw observations and take
   tested encrypted database backups, including historical prices and repairs.
2. Mount `Dusk Deploy`. Verify encryption, owner-only signer permissions and
   public IDs. Compute current buffer rent, IDL funding and fees. Do not reuse
   the initial-deployment budget or print key material/RPC credentials.
3. Run the temporary release preflight. It rejects changed code/authorities,
   unknown economic accounts, moved receipt supply and a new beneficiary.
   Upgrade Dusk only and immediately upload its bundled temporary IDL through
   `scripts/v2/upload_idl.sh`. Keep delegate on the reviewed old executable.
4. Verify finalized temporary code/IDLs. Normal financial entrypoints are absent
   in this build. Submit its freeze, preserving the exact interest clock, market
   hash, all receipt mint/holder bytes and all eight underlying vault budgets.
5. Capture a finalized bank and complete program catalogs. Build the explicitly
   labeled old-executable quote model from the on-chain cutoff. It substitutes
   only verified old code, cutoff clock, preserved receipt bytes and frozen
   vault amounts. Post-cutoff donations and review time do not change claims.

The quote model is local evidence, not an observed RPC bank or an active pin.
Do not change production decoding, cursor identity or price-repair identity to
make it pass. The old isolated SDK/runtime is retained solely for this model.

## 3. Review and authorize funded settlement

1. Run the existing legacy quote tool on the model. Require exhausted debt,
   hLP funding and unpaid income; full holder/claim catalogs; no wallet token
   spending; exact asset conservation; and classified permanent residual.
2. Compile the immutable six-owner manifest from the actual capture, model,
   quote and exact-binary native proof. Record exact token amounts, integer
   minima, custody budgets, personal-account hashes, recipients and all roots.
3. Run the second native replay from the actual frozen temporary bank using
   that manifest's actual source slot and hashes. Test the same begin, clear,
   associated-token creation and payout instructions as the operator. Verify
   every user/treasury delta and recoverable typed CPI events.
4. Review the final manifest before authorizing irreversible begin. A funding
   attestation is not permission to quietly choose another quote or recipient.

Before begin, a reviewed old-code rollback can resume the market. A resumed
market that changes invalidates the old freeze; the helper permits resetting
only a genuinely stale, unfunded cutoff. It cannot reset an unchanged cutoff to
charge users interest for review time.

## 4. Execute, reconcile and preserve claims

The local operator defaults to preview and requires explicit execution, checked
merged source, encrypted local signer, actual non-local capture, matching model
and frozen proofs, and a private signature journal. It rechecks program/IDL and
manifest identity, simulates with signature verification, submits with preflight,
waits for finalization, and resumes from on-chain masks.

1. Begin once. Consolidate only frozen custody, fund all immutable claims and
   replace the old market header with a permanent retirement tombstone.
2. Clear all 28 scoped personal accounts in six complete owner groups, returning
   their actual SOL rent. All groups clear before any principal/income payout.
3. Pay each owner its fixed net OMFG/META. Both legs and the paid flag are atomic.
   Unsafe/issuer-blocked recipients remain unpaid with no deadline; do not
   redirect or write off those claims to finish an upgrade.
4. Pay treasury only after every owner is paid. Reconcile all eight vaults,
   post-cutoff donations, personal closures, token receipts and journals against
   finalized chain evidence. Run the read-only completed-state verification.
5. Preserve the empty delegate order's ordinary owner cancellation/rent path.
   It has no staged token funds. Owners may burn/close their obsolete LP token
   accounts; protocol metadata/mint/vault rents and permanent tombstone remain.

Do not count the old-binary model's hypothetical swaps as actual trading volume,
realized trades or canonical financial events. Persist actual retirement CPI
observations under their own verified temporary identity and complete
instruction/CPI path before projecting payouts/closed positions. An unobserved
zero must not replace a verified historical nonzero snapshot. The retirement
interval and terminal reconciliations are separate from normal layout-19 state.

## 5. Normal program, SDK and data cutover

1. Require completed retirement masks, zero remaining funded claims, permanent
   tombstone and closed personal accounts. The separate successor upgrade
   preflight also rejects an extra legacy claim and verifies exact prior code,
   IDs, authorities and funding. Old market bytes must never be read as layout19.
2. Upgrade delegate first while the temporary Dusk binary rejects normal
   instructions, then activate normal Dusk last. Use the exact reviewed normal
   bundle and upload each matching bundled IDL immediately. This ordering keeps
   the first possible normal Dusk write after the common replay boundary. Verify finalized bytes and both IDL /
   upgrade authorities, then complete independent source verification against
   the exact normal commit/profile. Keep external signing closed throughout.
3. Publish only in an authorized window after the final normal binaries, IDLs
   and authorities match. The automatic #113 push publisher targets merge commit
   `1b6dc5379b049d6347dbaa70a704c6e4086b7a83`; it correctly skipped npm while the
   legacy programs remain deployed. #117 changed no SDK files, so it did not
   create a publisher run for final main. Use the protected release tag
   `dusk-sdk-v3.0.1` on the exact deployed normal commit (currently planned
   `aa196e3423fd5f46b00630a4f161d91f95ef7b3d`) to trigger the matching publisher.
   Do not re-run the earlier #113 publisher against later-commit binaries.
   Confirm actual version, dist-tags, provenance and tarball integrity. Never
   use manual `npm publish` or republish a version. Do not create the tag during
   source-only preparation.
4. Promote backend migration, actual SDK, protocol lock, runtime binaries and
   quote artifacts together. New `(cluster, program_id, idl_hash, revision)`
   identity means a fresh scoped cursor and verified deployment interval.
   Replay/reconcile from the first slot after both programs are active, retain
   the old interval and refuse any wrong identity or gap falsely marked complete.
5. Deploy the pinned frontend only against that coherent API identity. Activate
   #239's asset policy with the compatible program/SDK, not against SDK2.27.
   Pass manifest, deployment envelope, read/mutation boundary, UI preservation,
   complete tests, typecheck, lint and production build. Validate histories,
   charts, search, USD values, PnL, APYs, grouped claims, performance and preview
   CORS. No wildcard Vercel policy or new AWS provisioning is needed here.

Merged indexer #104 keeps byte-verified layout-17 portfolio checkpoints readable
under a successor identity. Its active-pin deduplication leaves current reads
unchanged. The webapp must explicitly register the matching historical tuple
before promotion; active trading/quote/signing checks stay strict. Record the
actual temporary interval/IDL/lock before adding its observations to an archive.
After settlement and before helper removal, use indexer #107's read-only
`duskRetirementReceiptArchive` tool with the exact clean merged core checkout,
release bundle and six actual reviewed evidence files. It preserves finalized
signed transactions, block membership, complete CPI arrays and both deployment
records, checks every payout and retains losing/partial raw observations.
Local-only rehearsal witnesses are rejected. Canonical decode and terminal
cash-flow projection still run through the common identity-scoped ingestion path;
the archive alone cannot authorize normal promotion.

Apply additive migration `060` before deploying the verified-empty portfolio
worker. It uses a finalized full market scan with before/after code and IDL
checks to establish a zero-position current portfolio between retirement and
the first replacement market. A missing streamed market alone is never a zero.
Verified history revisions supply owner addresses only, including when a
permissionless replacement market exists before the first empty capture. Every
retired owner must receive an observed current checkpoint before public traffic;
old financial state never enters the successor decoder.

Retain migrations through `060`, dated prices, Birdeye repair evidence, cash-flow
provenance and the historical-price/portfolio batching fixes from #97/#98.
Database rollback never undoes on-chain settlement or authorizes rewriting a
finalized observation.

## 6. Controlled testing and keeper activation

The six AWS KMS workers stay SHADOW until a new actual mainnet lock is captured,
all required release scenarios pass and each worker verifies direct-RPC identity,
fresh state, simulation, signing limits, lease and journal immediately before
submission. A layout-17 waiver cannot authorize layout19 or shared/local keys.

After the user creates a replacement market in the UI, separately approved
controlled tests must cover creation with genuine USDC/USDv, swaps, borrow/repay,
leverage/TP-SL, hLP and junior flows, fees/claims, loss/liquidation, keepers and
portfolio visibility. Until that market exists, report these mainnet write gates
as unexecuted. A passing offline/CI gate is not a live E2E result.

After irreversible retirement begin, restoring the old binary does not restore
old redemption rights; the tombstone is permanent. After new normal state is
created, a blind binary/database rollback can strand accounts. Stop signing and
use a reviewed roll-forward/recovery plan. Preserve every release, journal,
observation, interval and immutable SDK version.
