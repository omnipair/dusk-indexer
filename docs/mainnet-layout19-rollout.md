# Coordinated mainnet upgrade to accrued interest

Status: preparation only, 17 November 2026. This document does not authorize signing, deployment, publication, market creation, closing positions, changing authorities, or activating keepers.

## Current deployment and proposed changes

The finalized read-only inventory at slots 470551366–470551367 found one layout-17 market, seven leverage-position accounts, one borrow-position account, twelve yield accounts, twelve income archives, a junior exit, retired cohorts, and a delegated leverage order. Accounts existing is not equivalent to every account having an open balance; inspect each exact balance before execution. The market currently has nonzero debt, srLP/hLP supply and unpaid yield. It cannot be treated as an empty deployment.

- Dusk: `DuskWhswJYrzABDn8GqQD191X9RobRi5jhgGntXEdnKj`.
- Delegate: `DeLegABhDLREbDpwwcsbkHvDS5MwqKPAw1CJKoooUXFQ`.
- Active revision: `mainnet-2026-11-14`; SDK `2.27.0`.
- Existing market: `7xf68VEvMtLJ2Up5zVZdA161uH1yNkTFYgDFhNUSwkM7`.
- Current backend release: `9ce182e77f0e2fd0311659e60209864082346493`. Preserve its historical-price batching, portfolio query improvements and migrations through `059`.

The release keeps the agreed program IDs and local encrypted-volume signer workflow. It does not move authorities to Squads or change signing providers. Existing program and IDL authorities must be read back, rather than assumed from this document.

| Component | Preparation | Activation requirement |
| --- | --- | --- |
| Programs | #112, #114, #115, and separately reviewed #113 | One final combined main commit; exact verified production bundle for both programs |
| SDK | Stable versions for the mainnet build; proposed `3.0.0` for #115's removed public APIs | GitHub publisher only, after exact binaries, IDLs and authorities match |
| Indexer | #99 stages the decoder and pure candidate accounting; current API behavior stays intact | Separate API cutover, new revision/interval, matching quote artifacts and replay |
| Webapp | #239 asset admission; #240 accrued-interest port | Published SDK, registry integrity, protocol manifest and API identity updated together |
| Keepers | Existing KMS wallets and SHADOW workers | New frozen lock and full release evidence; no inherited layout-17 waiver |

Merge preparation independently where its checks pass. Do not let a merge imply that a deployment or publishing gate passed. The final SDK version is fixed in the final source PR; do not overwrite a published version or invent a registry checksum.

## Gate 1: decide how existing accounts survive

Layout 19 removes income books and interest vaults, shrinks Market, changes YieldAccount and operator revenue, and changes hLP state and instruction accounts. Uploading an IDL or restarting an indexer does not migrate those bytes. Neither #114 nor #115 supplies a production migration instruction for existing accounts.

Two options require an explicit owner decision before execution:

1. **Wind down the existing market using the current binary.** Obtain owners' authorization for closing trades, orders and loans; settle repayment, collateral, hLP, junior exits and all owed yield first. Inventory retired receipts, income archives, referral/operator/protocol claims, auction inventory, reserve dust and permanent junior seed. Do not assume permanent seed or every account can be closed. Produce a balance reconciliation and identify any value that the new binary would strand. Users create any replacement market through the UI; this preparation creates none.
2. **Implement and audit a real migration.** Preserve every principal, debt share/index, accrued entitlement, cohort, escrow, authority and custody balance. Rehearse against a finalized clone and prove conservation and replay compatibility. If safe migration is unavailable, retain the current program deployment; do not reinterpret layout-17 bytes as layout 19. A separate program deployment would require an explicit ID and funding decision.

A wind-down is not complete merely because the UI displays no positions. Require chain-level evidence and a signed-off reconciliation for all remaining liabilities. The additional five Dusk accounts are the canonical Anchor IDL and four LP transfer-hook validation PDAs; the delegate also has its canonical IDL. There are no unclassified accounts in this snapshot. Re-run classification before execution. No forced closure, haircut, abandoned claim or lost permanent seed is approved by this plan.

## Optional compatible USDC release

If USDC support is urgent, #112 can be released independently using its own exact post-merge main bundle and stable SDK version. Its freeze-authority policy change leaves layout 17 and the wire IDLs unchanged, so it does not require the layout-19 account transition. This would be a separate explicitly authorized upgrade with normal binary/IDL/authority verification and a compatible deployment interval. It does not add USDv's other extensions or authorize #114/#115. Do not deploy a later main-head bundle while calling it the #112-only release.

## Gate 2: freeze and test the combined source

1. Merge #112, then #114, then #115. Integrate #113 against that final code and rerun its extension-specific lending, LP, liquidation and custody tests. Preserve the hLP and ordinary flash fixes together. Do not bypass an unresolved issuer-control finding by silently narrowing the product.
2. Generate both IDLs and TypeScript interfaces from the actual combined source. Run every local CI gate and all GitHub jobs. Re-measure compute baselines only from a fully successful run; retain the ordinary swap hard ceiling and exact 5% regression margins. Never replace missing measurements with a pass.
3. Build and test the exact post-merge production commit in `release-build.yaml`. Record both ELF hashes, IDLs, SDK version, compiler image/arguments, account layouts and authority expectations. Download and retain that immutable bundle.
4. Rehearse the actual transition on a finalized clone: pending transactions, current account handling, USDC/Token-2022 admission, both flash routes, hLP, orders, fees, claims, liquidation, deficit/loss allocation and failures/rollback. Old-client transactions must fail safely after the transition. No live market is created during preparation.

The old initial-deployment runner intentionally rejects an existing program with different bytes. It is not an upgrade command. Review a separate upgrade execution procedure against the old and new release manifests; its preflight must verify the exact old ProgramData, program/IDL authorities, mainnet genesis and available rent/fees before any write. Use only the new bundle's binaries. Do not substitute devnet or regular Anchor build output.

## Gate 3: prepare the data and client cutover

The API cutover is not ready while its tests use layout-17 captures with layout-19 formulas. Replace those candidate tests with authenticated, schema-bound layout-19 fixtures and keep independent layout-17 regressions. The active #99 preparation deliberately retains current production accounting.

- Archive the old lock, both IDLs, deployment interval, quote runtime/manifest, price references, decoder and release artifacts. Finalized observations remain immutable with their original identity. Do not relabel them with the new hash or reset away portfolio history.
- Preserve dated prices, Birdeye repair evidence, cash flows, history provenance and the performance changes in #97/#98. Provide and test an explicit archived-revision history reader before claiming that a new pin preserves old wallet history. A fresh cursor alone does not do this.
- Generate the new complete identity tuple: cluster, program ID, canonical IDL hash and revision. Bind the delegate, deployment interval, runtime binary and SDK to it. Stage a fresh cursor, replay and reconciliation from the first slot after **both** programs become active. Keep the old interval readable.
- Prepare the webapp SDK/package-lock material and manifest together after the stable package exists. #240's three manifest failures are mandatory gates, not expected failures to waive. Production builds, read/mutation identity rejection, grouped claims, payable interest, USD values, PnL, history, market discovery, charts and APYs must pass against one coherent API identity.
- Confirm HTTPS, gRPC, production and verified-preview CORS origins, streams, alert delivery and backup restoration. No wildcard preview origins or new infrastructure provisioning is needed for this preparation.

If keeping an archived reader temporarily, use an explicitly read-only historical surface. An old service must not continue simulating or capturing live protocol state after its program identity changes. Do not weaken live identity checks to make an archive request work.

## Authorized execution window, later

After the preceding gates and explicit execution authorization:

1. Announce a maintenance window and quiesce signing/capture workers. Reconcile pending transactions and signer journals; allow old prepared transactions to expire. Take tested encrypted native/keeper database backups and save finalized chain/account evidence. A proposed reduce-only setting is not a full protocol pause and must not be treated as one.
2. Mount `Dusk Deploy` locally. Verify signer public keys, encrypted mount and owner-only permissions without copying secrets. Calculate current upgrade-buffer rent, ProgramData extension rent, both IDL allocations and fees from the final bundle. Do not assume the initial deployment's budget applies to an upgrade.
3. Upgrade both programs from the reviewed buffers/binaries, then upload **both** bundled IDLs with `scripts/v2/upload_idl.sh`. Keep external signing closed while either program, IDL or authority check is incomplete. Read back finalized code bytes, IDLs and authorities and complete public source verification against the exact commit and build arguments.
4. Re-run the protected GitHub SDK publisher. Verify provenance, actual npm version/dist-tags and tarball integrity. Promote the complete backend identity/artifact set together, deploy the prepared API/ingestion/quote workers, replay/reconcile and verify the common activation boundary before deploying the pinned frontend.
5. Keep keepers in SHADOW until the new lock is CAPTURED/frozen, all required release scenarios pass, and each KMS profile verifies identity, simulation, limits, leases and reconciliation immediately before signing. The old scoped release waiver does not authorize the new revision. Do not switch AWS workers to local key files just because another PR supports them.

The deployment window ends only after existing-history parity and controlled financial-flow checks pass. If a new market is needed for mainnet execution tests, the user creates it from the UI and separately approves the test transactions. Until then, report live-write checks as unexecuted.

## Rollback limits

Before the first layout-19 state mutation, restoring the old verified programs, IDLs, clients and pin may be possible only after proving all persistent accounts still match the old layout. After layout-19 markets/positions exist, a blind binary rollback can strand them; stop signing and use a reviewed roll-forward or migration instead.

Database rollback does not undo on-chain changes. Never delete or rewrite finalized observations to imitate a rollback. Restore backups only with an explicit recovery/replay procedure and preserved identity intervals. SDK versions are immutable; client rollback pins the previously published version rather than republishing it.

## Unresolved release gates

- Existing-market wind-down versus audited state migration, including permanent seed and every remaining claim.
- Final combined source and exact production-binary evidence after all program changes.
- #113's issuer-control review and extension-specific regressions for every affected temporary vault.
- Candidate API fixtures, archived-revision portfolio/history compatibility, and coherent deployment promotion.
- Published stable SDK/manifest, frontend production validation, and a new keeper lock/release matrix.
