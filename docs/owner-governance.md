# Owner governance balances

`GET /api/dusk/v1/owners/<wallet>/governance?market=<market>` retains its v1 identity envelope and adds reusable balances and allocations. Proposal support rows expose direct and reusable amounts separately; their sum remains `lockedAmount`.

Event history discovers candidate balances and allocations. One current RPC bank, at or after the stream cursor, verifies their native PDAs, market, owner, current delegate, available amount and original rent-refund recipient. Revoking a delegate removes its access even before discovery events catch up. Missing allocations make the capture unavailable rather than inventing an available allowance. The webapp consumes this API; it does not poll governance program accounts for display.

Governance balances remain owned by the depositor. Delegates may create/support proposals and release unlocked support; only owners may withdraw yLP or change a delegate. Reusable and direct support both permit exact partial withdrawal before queueing. Queued support retains the existing execution lock. Yield checkpoints feed normal yLP yield accounts.

Market snapshots add `liquidityStatus` (`active` or `empty`). A drained market retains minimum locked shares and actual reserve dust, while the native preview reports zero executable depth. Its configured reference prices and history are preserved.

Validation: API build and 269 unit tests pass, including native account decoding, revoked delegation, wrong-market rejection and incomplete-allocation rejection. Devnet acceptance is recorded with the rollout evidence.
