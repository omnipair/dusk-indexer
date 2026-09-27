# Governance proposals (`dusk-governance-proposals.v2`)

`GET /api/dusk/v1/governance/proposals` covers every market;
`GET /api/dusk/v1/governance/proposals?market=<base58 pubkey>` covers one. A
non-canonical, empty or repeated `market` returns 400. Responses use the
standard `{ success: true, deployment, data }` envelope with
`Cache-Control: no-store`, and are read from the database: no chain read.

Proposals come from their streamed lifecycle events (migration 047):
`ParameterProposalCreated` carries the proposal's terms, update and metadata;
`ParameterProposalSupported`, `ParameterProposalSupportWithdrawn` and
`ParameterProposalQueued` carry totals; `Queued` and `Executed` set status 1
and 2. Each market's eligible yLP is the sum of streamed yLP balances outside
the market-owned hLP vaults. Locked yLP is the sum of proposal totals. Direct
Token-2022 burns outside protocol events can overstate eligibility; that is
conservative for the API display.

```ts
{
  schemaVersion: 'dusk-governance-proposals.v2',
  market: string | null,          // the selection; null for every market
  sourceSlot: number,             // the stream's slot; covers every event included
  markets: Array<{                // every market with a proposal, plus the selected market
    address: string,
    eligibleYlp: string | null,   // null when MarketCreated has not been streamed
    governanceLockedYlp: string | null,
    observedSlot: number | null,
    observedAt: string | null,
  }>,
  proposals: Array<{              // sorted by market, then address
    address: string, market: string, proposer: string,
    nonce: string, family: number, familyRevision: string,
    digest: string,               // 64-character lowercase hex
    update: unknown,              // decoded MarketParameterUpdate: { variant, fields }, fields an array for tuple variants
    metadata: { version: number, title: string, descriptionUri: string, descriptionSha256: string, descriptionLen: number },
    sponsorshipFloor: string, initialSupport: string, totalLocked: string,
    status: number,               // ParameterProposalStatus: Collecting, Queued, Executed, Cancelled, Expired, Stale
    eligibleSupplyAtQueue: string | null, queuedSupport: string | null, // total locked when queued
    queuedAt: number | null, executeAfter: number | null,
    executionDeadline: number | null, executedAt: number | null, // unix seconds
    createdSlot: number, lastSlot: number,
  }>
}
```

Time-based expiry is not an event; clients derive it from `executionDeadline`.
Integers are decimal strings; pubkeys are base58. Per-supporter locked yLP is
in the `streamed_governance_supports` view.
