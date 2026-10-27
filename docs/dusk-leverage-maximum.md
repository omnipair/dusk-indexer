# Input-driven leverage Max preview

`POST /api/dusk/v1/previews/leverage-maximum` accepts
`dusk-leverage-maximum-request.v1`: an unsigned base64 v0 transaction, owner,
market, debtAsset, raw marginAmount, minimumSourceSlot and deploymentIdentitySha256.
The transaction must contain one SDK `openLeverage` at 1.01x with zero min output
and no referrer/delegated owner, one bounded compute-budget instruction and only
normal account-setup instructions. Address-table lookups and signatures are not
accepted. Requests are capped and are never submitted to Solana.

The response is `dusk-leverage-maximum.v1` with the normal deployment envelope and
`data`: kind (`maximum` or `capacity`), sourceSlot, original transactionSha256,
multiplierBps or native rejection, and timing/candidate metadata. The response is
not cached. Busy is 429; malformed input is 400; unavailable native execution is
503. Cancellation terminates its isolated evaluator. Ordinary previews and trade
submission do not depend on this endpoint.

The browser binds the result to its exact message, bank floor and deployment,
then obtains one fresh full RPC execution receipt at the selected leverage. A
market change may invalidate that candidate. This is a retry/validation outcome,
not permission to reuse the older bank. The final quote may then be reused by the
same form input for its existing 15-second validity, avoiding a second automatic
preview after Max changes the slider.

Financial state is not cached. The browser may reuse account setup/address plans
for ten seconds, bounded to 16 entries per SDK program. Native-SOL funding is
amount-dependent and excluded. Each new amount rewrites both margin and leverage,
each financial quote runs a fresh execution check, own confirmed mutations change
the cache scope, and setup failures invalidate the cached plan.

See `protocol/quote-runtime/README.md` for runtime identity and metering limits.

## Fixed-leverage size input

The same endpoint additionally accepts `size: { amount, kind, multiplierBps }`.
`amount` is a positive raw u64, `kind` is `collateral` (tokens bought by a long)
or `notional` (tokens sold by a short), and the transaction's multiplier must
exactly equal `size.multiplierBps`. The size search changes margin only. It
returns `kind: size`, raw `marginAmount`, achieved `sizeAmount`, the unchanged
multiplier, and the same bank/message/deployment bindings. A capacity rejection
never silently lowers leverage. The bounded native evaluator executes all
candidates against the original bank and decodes actual position receipts,
including transfer fees, concentration, hLP adjustments and integer rounding.
Native SOL candidates resize wrapping as well; the browser rebuilds its final
SDK funding plan for the calculated margin before its one fresh RPC check.

The browser requests maximum capacity automatically when debounced collateral
changes. This indexer-only capacity hint sets the slider's current upper limit;
it does not simulate another entry or change the selected leverage. Max is an
explicit user action. Stream ticks, focus and timers do not request previews.
Required margin and the entry receipt still expire and require explicit refresh
before submission. The IDL's absolute ceiling remains enforced by the program;
the trading form does not present it as available leverage.

Validation: native round-trip size checks cover both debt directions, CPMM and
concentrated curves, transfer fees, both hLP vaults, and compounding. The devnet
fixture needs 76,517,341 raw margin for at least 1,000,000,000 raw collateral at
3.5x; one less raw margin falls short. Unreachable sizes reject at fixed leverage.
