# Native leverage-capacity candidate runtime

`dusk.so` is the exact unpadded SBF payload from Dusk commit
`77877d576018fd2bd8191d13f05534b0484e2282`, deployed on devnet at slot
515502278. The manifest verifies its payload hash and its zero-padded on-chain
allocation hash against `compatible-deployment.json`. A future Dusk deployment
must update these artifacts together; a mismatched runtime refuses quotes.

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
account data, unsigned transactions and expected results. The live fixture is the
existing 3A9o devnet market. The eight offline cases were generated through the
Dusk smoke harness's real market creation, liquidity and both hLP deposit paths:
CPMM/concentrated (3x, 250-bps core, 500-bps shoulder), both debt directions,
classic/Token-2022 transfer fees and 50% swap-fee compounding. The independent
original SBF runtime accepted each selected economic grid point and rejected its
next point under the same financial-capacity budget. These are offline financial
parity checks, not a claim that every case fits devnet's execution budget.
