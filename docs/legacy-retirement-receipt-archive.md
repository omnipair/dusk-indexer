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
bounded signature history within that deployment interval. It preserves the
signed transaction, complete inner-instruction arrays/stack heights, loaded
addresses and exact finalized block membership. It verifies all transaction
signatures and reconciles one begin, every personal clearance, every user's
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

The generated test IDL is copied byte-for-byte from the unsigned retirement
bundle for source `3231586c56cc259711f974eb720b89c118276d19`. It is a test fixture,
not an active protocol lock or authority to execute the retirement.
