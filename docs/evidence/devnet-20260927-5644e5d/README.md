# Dusk devnet event snapshot upgrade

Dusk PR #40 source `5644e5db86d63311b35b8373992f8fa210ef3ccf` was deployed at finalized slot 504809896. The entire dumped ProgramData binary matches the local tested artifact byte for byte. The leverage delegate remains at slot 497831834.

Transaction: `4HWwJa71qXNwWC4KTb3t9Ni96ALarAo9LNMUUrifS1whr1oURmo3oh4mWBWGwgG5NJWNdwzn6kP5645RGdVrKE2R`. The previous protocol pin is preserved here and in `protocol/archive/devnet-2026-09-18-932018a/`. The IDL compatibility review records the changed instruction and event definitions.

The signed devnet swap has also been replayed through the indexer daemon into a disposable PostgreSQL database; see `devnet-swap-event.json` and `replay-verification.json`. The deployment readback verifies binary bytes and identity.

Deployment-scoped SDK SHA-256: `bc2373ec73ec9b7fac654e0d64df951c63445bb3d0827ec902d437a5e13210e4`. It combines the new Dusk generated IDL/types from PR #40 with the unchanged, deployed leverage-delegate IDL/types from the previously reviewed `2.10.1-devnet.20260918` archive. The undeployed protection client export is excluded.

A finalized 0.01 mock-token swap from a dedicated test wallet on the hLP-free `base-quote-2` market emitted one `SwapExecuted` event CPI with both post-trade price, EMA and growth snapshots. The signature and decoded values are in `devnet-swap-event.json`.

The deployment-scoped SDK packaging recipe and compatibility rationale are in `sdk-packaging.md`.

The live Railway API verification is in `live-service-verification.json`. A market created after the new confirmed-event stream began was followed by one liquidity deposit and two signed swaps. The API reports four canonical events for that market, two projected quote-history captures, and two projected activity events with no pending projection. Both swap prices appear in the quote candles. The first swap remains unpriced for activity because it has no strictly prior-slot observation; the second uses the first swap's snapshot. This does not establish historical external-provider price coverage.

The activity and yield-claim workers preserve the database's exact microsecond event time when writing projections. Their focused disposable-PostgreSQL regression tests pass, and all four indexer PR checks pass at commit `3d79748`.
