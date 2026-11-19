# Native leverage-capacity runtime

`dusk.so` contains the exact 4,058,688-byte on-chain ProgramData payload for Dusk commit `aa196e3423fd5f46b00630a4f161d91f95ef7b3d`: the tested 3,824,008-byte production ELF followed by zero allocation padding. Dusk finalized at slot 471276209; the delegate finalized at 471275760, so the complete revision starts at 471276210. The old layout-17 runtime remains immutable under its original archive.

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

Current layout-19 depth fixtures execute this exact production SBF against a synthetic bank produced by the matching smoke harness, with explicit Clock, Rent and CPI executable bytes. They verify 12/24/36 levels, stable bank reuse, stale/foreign deployment rejection and worker cancellation. The static layout-19 decoder fixture preserves historical financial inputs and return data for transport regressions; it is not presented as a new SBF receipt.

Archived leverage-capacity fixtures keep their original IDLs, executable hashes and economic inputs. They retain CPMM/concentrated, both debt directions, transfer-fee and compounding coverage under their historical revisions. Replacement-market mainnet write and native-capacity acceptance awaits the owner's UI-created market; synthetic fixtures do not claim that live gate passed.

Previous runtimes and their immutable parity fixtures remain bound to their
archived IDLs and executables. They are not relabelled as current accounts.
