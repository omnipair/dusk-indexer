# Oracle policy projections and the OP-GAMM candidate

Companion to [frontend PR #108](https://github.com/omnipair/dusk-webapp/pull/108)
and [protocol PR #58](https://github.com/omnipair/dusk/pull/58).
This adds the read contract for oracle-guided creation, market Parameters and
governance. It does not deploy programs or promote an undeployed interface into
the current deployment identity.

## Market read contract

The existing market payload gains `oraclePolicy`. It comes from the same captured
Market account as the other configured terms. It is available even when a stale
or invalid feed makes the simulated valuation unavailable.

```ts
oraclePolicy: null | {
  format: number;                   // 0 = native default, 1 = normalized pair, 2 = Pyth ratio
  provider: string;                 // canonical base58 program ID
  baseAccount: string;
  quoteAccount: string;
  baseFeedId: string;               // exactly 64 lowercase hex characters, no prefix
  quoteFeedId: string;
  lambdaBps: number;
  adjustmentCapNad: string;         // u64 decimal string
  maxAgeSeconds: number;
  maxAgeSlots: string;              // u64 decimal string, never converted to Number
  maxConfidenceBps: number;
  maxPublishSkewSeconds: number;
}
```

`null` means the pinned old account layout has no OracleState. It does not mean
native pricing. A present malformed policy fails the read. A fully zero policy
is the new layout's explicit native default. A retained source with zero lambda
is also native execution; its disclosed source settings remain visible.

These are configured terms, not a feed-health claim. Last-consumed observations
do not prove that the latest report is healthy. A rejected preview keeps the raw
inventory/policy visible but leaves preview-only valuation, spot and rates
unavailable. There is no inventory-only fallback fabricated by the API.

For the new layout, market capture first reads the authenticated policy at or
after the requested floor. It includes the configured report accounts as read-only
metas in the unsigned preview, then captures all returned accounts at the same
simulation bank. A failed preview uses a new coherent RPC account bank instead
of failed simulation state. Identity and slot checks remain mandatory. Zero
lambda requests no report accounts. The legacy layout retains its existing path.
The on-chain program validates report owner, identity, timestamps and confidence.

## Governance and other read paths

The family revision count follows the verified IDL: seven for the active pin,
eight for the candidate (Oracle is family 7). Event JSON remains in the Rust
Borsh decoder's representation: decimal-string integers, base58 public keys,
`{variant, fields}` enums, and `0x`-prefixed fixed-byte arrays. The FE must convert
these exact bytes before checking the proposal digest. The API does not turn
feed IDs into arrays or re-encode proposal terms.

The existing streamed-governance SQL views retain the created payload and are
already revision-scoped; no migration is needed for the extra family. Replaying
new events under an old identity is forbidden.

Runtime SDK selection requires an exact canonical IDL match and also checks the
delegate IDL. The current SDK remains installed; the candidate SDK is a separate
vendored alias. Layout-dependent account checks follow the verified pin. The
candidate's #59 health-only borrow previews omit removed distress state rather
than publishing an invented zero clock. Borrow preview instructions use the
matching SDK's oracle-aware account builder.

## Reviewed candidate, not a deployment

`protocol/candidates/next-2026-10-31-8fadcc31/candidate.json` fixes:

- Dusk source commit `8fadcc31fbe542f4f822060724639a5057fad2cc` from PR #58,
  including #59.
- Byte-exact generated Dusk/delegate IDLs, their raw and canonical SHA-256 hashes.
- SDK `2.15.0-next.20261030` and the exact tarball shared with FE #108.
- Synthetic SDK-encoded Market and Oracle-update bytes. Rust and TypeScript tests
  decode the same fixture, including a maximum u64 slot-age value.

There is deliberately no candidate `protocol.lock.json`, binary digest,
ProgramData slot or upgrade-authority assertion. `loadProtocolAt(candidateDir)`
rejects this incomplete deployment. Presence of the bundle never activates it.
The active `devnet-2026-10-26-cd6f1ec` pin and historical files remain unchanged.

Regenerate only the synthetic wire fixture from the repository root with:

```sh
node api/scripts/generate-oracle-fixtures.mjs
```

## Activated devnet revision — 31 October 2026

The tested #58 head is deployed on devnet under the existing program IDs.
`protocol.lock.json` records finalized deployment slots and executable hashes;
the prior identity is archived. [Deployment evidence](evidence/devnet-op-gamm-2026-10-31/deployment.json)
records the byte verification and seeded layout-7 market. Repository review and
merge status remain separate from the authorized devnet deployment.

Market discovery derives the fixed Borsh version offset and account size from
the pinned IDL: OracleState is serialized before version, so v7 uses offset333
and 3,461-byte accounts. Old-layout accounts are excluded before decoding.
Capacity, yield and hLP trigger previews carry their configured source reports.
The archived quote lineage includes the prior active revision.

## Rollout procedure

1. Verify the final protocol commit against this candidate. If its generated IDLs
   or SDK differ, vendor a new candidate and update the FE pin together.
2. After the authorized program/delegate deployment, record actual finalized
   ProgramData addresses, slots, authorities, executable allocation hashes and
   genesis. Preserve the previous lock, IDLs, executable metadata, references and
   needed quote runtime in the archive. Capture verified new quote-runtime bytes;
   the local leverage engine must not load the old binary under the new IDL.
3. Promote the matching generated IDLs, SDK metadata and complete new deployment
   lock. Update `indexer/crates/dusk-ingestion/src/lib.rs` constants (revision,
   both raw hashes and both canonical hashes), compatible-deployment metadata
   and price-reference revision. Rebuild the daemon and API. An ABI change is a
   new revision; it cannot use the same-IDL compatible-upgrade shortcut.
4. Run vendored-pin checks, decoder/account regressions and replay/reconciliation
   from the verified revision boundary. Check event coverage and the new
   governance family before starting fresh identity-scoped cursors. Do not
   relabel old captures, observations or cursors. The fixture tests establish
   codec compatibility, not historical coverage or replay completion.
5. Roll out the matching API/indexer and FE. Verify the deployment envelope,
   market/native/oracle creation, Oracle proposal lifecycle, stale-feed
   unavailability and fresh-feed recovery on dedicated test markets. Keep the
   deployment guard enabled until network/program/IDL/revision all match.

A Vercel preview built with the future SDK against today's indexer will show
**Deployment mismatch** until that coordinated rollout. Merging this support PR
alone does not authorize or perform a program deployment.

## Validation

Local gates cover Rust decoder tests/Clippy, API unit tests, migrations applied
twice on disposable PostgreSQL 16, rollback-only SQL/API integrations, byte-exact
candidate hashes, both SDK selections, Oracle family wire data, coherent report
capture and health-only borrow previews. Docker image packaging and the actual
Timescale hypertable job remain CI gates when those runtimes are unavailable
locally. Live new-revision replay and signed writes await the deployment above.
