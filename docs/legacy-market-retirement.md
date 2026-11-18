# Legacy OMFG/META market retirement proposal

Status: preparation, 18 November 2026. The read-only inventory script is implemented; retirement instructions and payout execution are not. It does not authorize deployment, reduce-only changes, forced closures, market creation, payouts, treasury transfers or SDK publication.

The owner selected payout of each wallet's final net entitlement in **OMFG/META**, accounting for debt, gains/losses and fees. This is not a refund of original deposits, and treasury compensation is not part of the design.

## Deployment and state boundary

- Legacy market: `7xf68VEvMtLJ2Up5zVZdA161uH1yNkTFYgDFhNUSwkM7`.
- Dusk program: `DuskWhswJYrzABDn8GqQD191X9RobRi5jhgGntXEdnKj`.
- Delegate program: `DeLegABhDLREbDpwwcsbkHvDS5MwqKPAw1CJKoooUXFQ`.
- Deployed source at preparation: `0acc9057b53a0495571f1bbf8a18e5db0f2efd45`, layout 17, SDK `2.27.0`, revision `mainnet-2026-11-14`.

The 18 November read-only capture found one market, **five open leverage positions, two loans, five owners with positions/receipts/historical yield accounts, and three current receipt holders**. It includes sixteen yield accounts, eighteen income epochs, two hLP cohorts, one junior cohort, two empty junior-exit tickets and one delegated leverage-order account. All current/retired receipt mints were enumerated using full token-program account scans and reconciled against mint supply, including non-ATA and protocol custody balances. The indexer reported approximately **$276 in reserve and position custody** at 03:23 UTC; this changes with prices and activity and is not the final payout total. Permanent junior receipts and the 1,000 locked senior shares are separate from freely circulating mint supply. Refresh and independently reconcile immediately before execution.

## Wind-down before terminal settlement

The owner has announced the intended OMFG/META wind-down to testers. This is an intention to retire that market, not authorization in this preparation round to change live settings or transact for users. The current binary can put a market into reduce-only; it has no general-purpose `close_market` instruction. Reduce-only blocks new borrowing, leverage increases and liquidity seeding while spot swaps and risk-reducing exits remain available. Borrow collateral withdrawal in reduce-only requires that position's debt to be zero. Normal health, available-cash, issuer-transfer and junior-exit timing checks still apply; reduce-only bypasses none of them.

Use this retirement sequence when execution is separately authorized:

1. Save a finalized account/balance snapshot and announce repayment, withdrawal and claim instructions. Users must cancel pending delegated orders as well as close trades; a UI notice alone does not cancel on-chain orders. Check the actual junior-exit tickets and notice windows before announcing a deadline.
2. Enable the chosen reduce-only setting through its actual authority. Market reduce-only requires the compiled emergency authority; global reduce-only uses the futarchy administrator and affects all markets. Do not assume the funded deployer can sign either setting without reading the live authority configuration.
3. Include forced position closures, as requested by the owner on 18 November. The one-off script must use separately reviewed legacy-compatible retirement instructions wherever normal owner signatures are unavailable; a script cannot impersonate owners. Close leverage, settle both lending sides, withdraw remaining collateral, unwind hLP/srLP and junior liquidity, cancel remaining orders and settle earnings under explicit reviewed rules. Reconcile pending exits, retired receipts, unpaid income, operator/referral/protocol liabilities, auctions and permanent junior seed. A balance unavailable for immediate collection remains a liability to resolve.
4. Re-run the complete inventory and prove where every remaining token and entitlement will live. With the same program IDs, simply leaving the old account marked reduce-only does not preserve its exit path: the layout-19 binary replaces the code used by that account too, changes its decoding schema and rejects unsupported versions. Implement and rehearse a narrowly scoped retirement/migration or compatibility path for any remaining value before upgrading. Retaining the old binary under a separate legacy deployment would instead require different new program IDs and an explicit release decision.
5. Retain the old revision's history in the backend and show the old market as retired, with any required claim/exit surface supported by the chosen on-chain path. A replacement market is a distinct market; its creation does not migrate the old balances or history.

For this small controlled market, an orderly wind-down is the preferred candidate to evaluate before attempting a live-position conversion. It is not yet a proven zero-liability decommission, and USDv remains subject to its separate final compatibility and issuer-policy review. The tester announcement must not promise an already completed upgrade, immediate junior exit, or finalized USDv release.

## Temporary retirement release

The owner asked whether a temporary instruction can return funds and then be removed. This is feasible as a separate reviewed release, not an administrative transfer that ignores the old accounting. The implementation PR must remain separate from the USDv admission proposal and the new interest layout. No such instruction exists in this preparation yet.

Prefer an interim retirement build that still understands the deployed layout-17 accounts, derived from the verified deployed source rather than the layout-19 main head. Finish the legacy retirement and reconciliation before the layout-19 upgrade. That path needs two reviewed program upgrades and exact release bundles; the protected build/publisher tooling must explicitly support the intended legacy source and must not be bypassed. If instead combining retirement with layout 19, retain an explicitly isolated legacy decoder and settlement path until every old claim is paid. Removing that code prematurely has the same stranding risk as an ordinary incompatible upgrade.

The proposed design has these requirements:

- **Bounded scope and authority.** Hard-bind the legacy program, layout, market, mints, vault derivations, permitted authority and one retirement generation. It must not be a reusable administrator sweep for other markets. Use a dedicated retirement-state PDA rather than silently changing old struct offsets. Begin/finalize authorization is separate from who pays transaction fees or submits individual owner payouts.
- **Frozen settlement state.** Reduce-only is the voluntary-exit phase. A final settlement snapshot additionally needs an on-chain terminal mode that guards every affected write path, LP transfer hook and delegated order; reduce-only alone still permits swaps and withdrawals. The final claim set must be derived and reconciled after that boundary. Define how remaining debt is repaid and how hLP, junior timing, accrued interest, outstanding orders, retired cohorts and issuer-blocked accounts are resolved; do not invent a liquidation price or waive debt to simplify the implementation. Forced closures are in the requested preparation scope. Their exact pricing, transaction ordering, slippage/minimum payouts and authority restrictions still require explicit review before execution; no treasury compensation or debt forgiveness is implied.
- **Exact entitlements and destinations.** The owner confirmed final net entitlements in underlying OMFG/META after debt, gains/losses and fees. There is no treasury-funded restoration of original deposits or forced USD conversion. Existing stored harvest recipients and delegated rights must be reconciled explicitly. Bind destinations to verified ownership/designated recipients, token mints and token programs; the submitter supplies no arbitrary recipient or payout amount. Include every wallet holding receipts, including non-ATA balances and escrow; existing protocol accounts alone are not proof of the complete holder set.
- **Single-use, resumable payouts.** Use bounded per-owner or per-claim transactions with immutable settlement commitments, replay protection, exact remaining liabilities and net credited-amount receipts. Token-account owners normally authorize LP burns; mint authority alone cannot burn arbitrary users' balances. Specify owner-signed redemption or a rigorously terminalized claim scheme that invalidates old receipts, blocks transfer/reuse and cannot pay the same economic right twice. A failed/frozen destination must remain unpaid and retryable; another owner's payment must not erase it. No timeout silently forfeits an unpaid claim.
- **Proven finalization and removal.** Reconcile custody by mint to paid claims, remaining reserves and approved non-user balances. Classify permanent junior seed, sub-atom/rounding residuals, donation dust, protocol/operator/referral balances and account rent separately; no implicit treasury sweep or loss write-off. Require proof that every claim is paid or preserved in a separately reviewed durable claim path before disabling the legacy handlers. A count asserted by an off-chain script is not proof that no holder was omitted. Keep a terminal tombstone or equivalent replay/reinitialization barrier where necessary, preserve historical events/identity intervals and archive the exact claim manifest and release artifacts. Only then can a subsequent audited release remove temporary execution code.

Before implementation is considered ready, clone finalized legacy state and test complete and interrupted batches; omitted/duplicate holders; multiple token accounts; receipt transfers around the freeze boundary; orders and both lending modes; retired and queued junior claims; rounding; token freeze/pause/transfer-fee failures; unauthorized/misdirected payouts; repeated begin/settle/finalize; and conservation before and after the final layout-19 upgrade. The live inventory must be refreshed after users finish withdrawing. The temporary design is not yet a deployed or audited refund mechanism.


## Open design decisions before a program PR

The selected operational shape is a **one-off, market-bound, resumable script, including forced closures**, followed by removal of temporary execution code only after complete reconciliation. Reuse ordinary accounting and repayment/close logic where possible; the reviewed temporary program authorizes only the specified retirement actions. The remaining decision is the unwind pricing/slippage rule, not whether to include forced closures. The proposed default for review is the existing market curve and ordinary fees, with per-operation minimum net payouts derived from the ordered clone rehearsal. No slippage percentage is approved yet.

For a residual distributor, a Merkle proof establishes membership in a committed list, not that the list includes every entitled holder. Provide enforceable aggregate conservation and completeness evidence. If existing accounting cannot prove there is no omitted/unpaid holder, preserve a durable legacy claim path and do not remove it. Never use an operator-supplied count as proof that a retirement is complete.

Permanent junior seed is intentionally not an ordinary user withdrawal. Its destination, claim treatment and any irreducible rounding or donation residual require an explicit approved disposition. Existing junior notice windows and non-liquid claims cannot be bypassed by the reduce-only toggle. Any change to those rights belongs in the reviewed program design.

## Read-only inventory script

From the repository root:

```sh
npm --prefix api ci
npm --prefix api run inventory:legacy-retirement -- /absolute/path/new-inventory.json
```

`DUSK_RPC_URL` may select the existing mainnet provider. Keep its credential-bearing URL in the local environment; the artifact and console do not record it. The script verifies the mainnet genesis, both exact deployed program allocations/hashes/upgrade slots/authorities against the checked layout-17 pin, and the indexer's program/IDL identity. It accepts only read-only RPC methods and writes a new evidence file without overwriting an existing one. It loads no signing keys, builds no transactions, does not simulate and cannot submit anything.

The JSON retains raw program accounts, decoded claims, all current/retired receipt mint accounts, full receipt holder accounts and market/order custody. Each source observation has its own finalized slot and digest. The API quote/price observation is separately marked confirmed; this is deliberately a **non-atomic inventory**, not a terminal settlement snapshot. `settlementReady` is always false. Missing receipt supply fails the capture; unclassified ancillary accounts remain an explicit blocker. Unknown or frozen destinations are not silently dropped.

The script's next stage is a finalized-clone settlement rehearsal with an exact ordered transaction manifest and owner OMFG/META payout receipts. This PR does not implement that stage. Today's balances, USD prices or supply proportions alone must never be treated as final net entitlements: debt repayment, hLP funding, yield receivables, queued/retired rights and permanent capital remain part of settlement.

## Backend and frontend handoff

1. Preserve the old immutable deployment interval, IDLs, lock, binaries, program authorities, event observations, dated prices, cash flows and wallet history. Keep historical-price and portfolio-query performance fixes in the deployed backend.
2. Add explicit terminal settlement/payout events to the retirement IDL and decode them under the exact temporary deployment identity. Distinguish withdrawals, PnL realization and any funding transfers; payouts are not invented market revenue or extra earnings. Prevent double counting ordinary exits plus retirement distributions.
3. Keep the maintenance/retirement client bound to its reviewed bundle and actual program/IDL identity. An old SDK must not prepare ordinary trades against the terminal market. Stable SDKs, if needed for the interim release, go through the protected GitHub publisher after exact deployment matching; never publish manually or invent npm integrity values.
4. Retain an archived revision history reader. Show the old market as retired and keep any required claim surface available until finalization. A replacement OMFG/USDv market has a distinct identity and is not evidence that old balances migrated. USDv remains subject to separate compatibility and security review.
5. Promote the final layout-19 programs, IDLs, published SDK, API/ingestion/quote identity, UI manifest and keeper lock in a separately rehearsed release. Keep keeper signing in SHADOW until its new evidence passes. Removing temporary retirement code requires a final paid-or-durably-preserved claims proof, including failed recipients.

## Reviewable execution evidence required later

Save before/after owner and vault balances by mint, net payout receipts, every settled/remaining claim, debt/share/index changes, terminal-state transitions, custody conservation, authorized residual disposition, transaction signatures and immutable artifact hashes. Include rollback/failure tests and a finalized-clone rehearsal. A failed transfer remains a claim; a database backup does not reverse on-chain payments. No live writes are included in this design PR.
