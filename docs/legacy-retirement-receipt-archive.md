# Archive actual retirement receipts before the successor upgrade

The temporary helper's IDL and executable must be preserved while they remain
live. Its payments are actual transactions. The old-program quote model's swaps,
repays and closes are hypothetical economics and must never become ordinary
trading volume, realized trades or canonical financial events.

After authorized settlement and completed-state verification, run the local
read-only archiver from this repository:

```
node api/dist/scripts/duskRetirementReceiptArchive.js \
  CORE_CHECKOUT RETIREMENT_BUNDLE MANIFEST CAPTURE MODEL QUOTE \
  MODEL_NATIVE_PROOF FROZEN_NATIVE_PROOF NEW_PRIVATE_ARCHIVE
```

`MAINNET_RPC_URL` is supplied locally. No signing keys are read. The six evidence
paths are exactly those accepted by the program's reviewed `verify` command.
The core checkout must be clean, at the bundle's exact commit, and merged into
main. Local-only manifests/captures are rejected before RPC or subprocess work.
The existing program verifier checks actual completion before and after the
archive. All reads are finalized; the transport permits only transaction/block
reads plus the standard read-only account and signature methods.

The archiver verifies the exact temporary binary and uploaded IDL, retains both
programs' deployment account bytes, and scans the retirement PDA's complete
bounded signature history, together with the freeze PDA, within that deployment interval. It preserves the
signed transaction, complete inner-instruction arrays/stack heights, loaded
addresses and exact finalized block membership. It verifies all transaction
signatures and reconciles the actual freeze, one begin, every personal clearance, every user's
exact two-token payout and the treasury's distinct residual against the reviewed
manifest. Failed transactions remain observations and never count as payments.
Source/IDL/deployment changes, missing receipts and partial history stop export.
Raw pages, transactions/blocks and before/after deployment reads are appended to
`NEW_PRIVATE_ARCHIVE.observations.jsonl` before receipt validation. Contradictions
or an interrupted scan retain that journal and produce no verified archive;
resume into a fresh output path after reconciliation. No losing finalized
observation is overwritten. The verified output is sealed, owner-only and
write-once.

The archive names a separate temporary `(cluster, program_id, idl_hash,
protocol_revision)` identity with its real source and deployment bytes. It does
not change the active pin, invent a published SDK, write database projections,
create canonical event keys or advance a cursor. The event coordinates are
validation evidence only. Canonical decoding, reconciliation and terminal
portfolio/cash-flow projections must use the existing common ingestion path
under that verified temporary identity before normal promotion/public traffic.
Retain the archive and actual frozen evidence with database backups. No
simulated old-program event may substitute for a missing actual receipt.

## Canonical replay and terminal withdrawals

The generated retirement IDL and immutable binary/source pin are stored separately
from normal two-program history releases under `protocol/retirement/aa196e3423fd`.
They come from the exact final-main unsigned bundle for
`aa196e3423fd5f46b00630a4f161d91f95ef7b3d`. No deployment slot is invented.

After the read-only archiver creates a `dusk-retirement-receipt-archive.v2` file,
run the reviewed indexer binary while the helper is still active:

```
dusk-indexer-daemon --retirement-archive NEW_PRIVATE_ARCHIVE
```

`DUSK_CLUSTER=mainnet-beta`, `DUSK_RPC_URL` and `DATABASE_URL` are supplied through
the normal private runtime. This operation reads chain data and writes the
existing database only; it has no Solana signer. For a one-off AWS task, the
`--retirement-archive-url` form reads `DUSK_RETIREMENT_ARCHIVE_URL`, an expiring
owner-issued HTTPS download of the proof from the existing private S3 backup
bucket. Store that value through Secrets Manager, never in source or logs.
No new task IAM permissions are needed. No live cursor or complete-range claim
is created by either form.

The command checks the exact helper code/IDL/authority and the sealed actual
archive before first registration, re-fetches every finalized signed transaction
and its containing block, and sends the original complete CPI data through the
same decoder and canonical persistence function as realtime and ordinary replay.
Only direct committed helper instructions qualify. All 15 emissions (freeze,
begin, six clearances and seven payments) must reconcile; treasury is distinct,
last and included in token conservation. No hypothetical model transaction is
published as a normal protocol event. Later replay requires the same immutable
registration and re-verifies the finalized transactions even after helper removal.

Migration 061 keeps the raw sealed archive before canonical projections. Fresh RPC candidates are appended independently before comparison; contradictory finalized responses halt replay while both observations remain available. A
partial or interrupted replay cannot produce a completed retirement ledger;
rerun the identical archive. The `retirement_payouts` view must show seven exact
payments before normal promotion. Portfolio history exposes each user's payment
as an additive, exact-native `withdrawals` record with both helper provenance
and the explicit retired identity. Treasury residual is excluded from user
withdrawals. Original checkpoints and their valuation/history hashes stay intact.
The helper's combined net payment is not misclassified as swap volume, earned
interest or borrowing cost. A cross-retirement earnings split is unavailable
unless separately supported by evidence; no USD valuation is fabricated.

V2 stores transaction/block metadata as opaque JSON strings so derived RPC UI
floats cannot change the archive seal between JavaScript and Rust. Exact signed
transaction bytes and raw token amounts remain intact. The nonfinancial runtime
rent epoch is omitted from loader metadata because web3.js represents its u64
as an unsafe JavaScript number; loader data, owner, authority, flags and IDL bytes
are retained and verified.
