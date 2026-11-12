# Native leverage-capacity runtime

`dusk.so` is the verified 4,019,608-byte payload from Dusk commit
`109580f668fe38318969c1278e58b7337ef10660`, upgraded in place on devnet at finalized slot
521463779. The compatible deployment records both program upgrade slots
and their full on-chain allocation hashes. The layout-15 event revision and its
original history boundary remain in `protocol.lock.json`.

The manifest pins both hashes; `compatible-deployment.json` pins the complete on-chain allocation. Future compatible upgrades must update these artifacts together. A mismatched runtime refuses quotes.

The preview adapter uses LiteSVM 1.6.1 in a separate process. The hashed feature
snapshot retains the 220 features used by Dusk’s strict offline runtime; the
request’s Clock and Rent sysvars come from the captured bank. Offline parity
fixtures retain their original test-runtime Rent alongside their account data.

The API accepts only an unsigned SDK leverage-open preview, captures one complete
confirmed account bank and matching Clock, and searches the 0.01x grid using that
program. It loads captured CPI executable bytes and keeps every simulation
noncommitting. An isolated process, cancellation, request concurrency, payload
bounds and a timeout contain each evaluation. No signer or send operation exists.

This returns an **economic-capacity candidate**, never an execution receipt.
Local VM compute metering differs across environments, so its local search has a
bounded 5M-CU budget. The webapp must run the selected original transaction through
one fresh RPC simulation with the actual 1.4M-CU ceiling and verify its native
position/event receipt before accepting the quote. A runtime/transport failure
never narrows the search or becomes a financial-capacity answer. No loan, margin,
fee, concentration or hLP financial rule is replaced with application math.

Only CPI program-data addresses are cached. All financial account bytes are
captured again on every request. A newly discovered executable address requires a
second complete capture; observations from different banks are never spliced.
A read-only simulation with a distinct payer captures small account sets without
charging the trade owner's snapshot. Larger sets, or a payer-owner collision,
use a bounded read-only batch retry and require Clock.slot == context.slot.

Fixtures in `api/src/tests/fixtures/leverage-maximum-*.json.gz` contain public
account data, unsigned transactions and expected results. Current live fixtures cover the fresh constant-product and concentrated
markets in both debt directions. Historical fixtures retain their original
identities. The eight offline cases were generated through the
Dusk smoke harness's real market creation, liquidity and both hLP deposit paths:
CPMM/concentrated (3x, 250-bps core, 500-bps shoulder), both debt directions,
classic/Token-2022 transfer fees and 50% swap-fee compounding. The independent
original SBF runtime accepted each selected economic grid point and rejected its
next point under the same financial-capacity budget. These are offline financial
parity checks, not a claim that every case fits devnet's execution budget.

Previous runtimes and their immutable parity fixtures remain bound to their
archived IDLs and executables. They are not relabelled as current accounts.
