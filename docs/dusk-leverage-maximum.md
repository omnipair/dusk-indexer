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
for five seconds, bounded to 16 entries per SDK program. Native-SOL funding is
amount-dependent and excluded. Each new amount rewrites both margin and leverage,
each financial quote runs a fresh execution check, own confirmed mutations change
the cache scope, and setup failures invalidate the cached plan.

See `protocol/quote-runtime/README.md` for runtime identity and metering limits.
