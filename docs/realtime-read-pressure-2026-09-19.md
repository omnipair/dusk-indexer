# Realtime read pressure and price freshness — 2026-09-19

A Leverage page refreshes multiple read families on native stream hints. The previous 100 data / 600 identity requests per minute per IP did not accommodate two connected sessions and their fresh API/RPC identity brackets. The frontend also allowed each change burst to revalidate the whole page every 250ms.

The paired frontend change bounds change-driven refreshes to two seconds and retains a pending hint during reads. API defaults are now 1,200 data / 3,600 identity requests per minute per IP, with separate configurable budgets. Rate-limit rejections now pass through request metrics and structured failure logging. No deployment, schema, slot or transaction check is removed.

Current market snapshots are invalidated alongside other projections when active-deployment notifications arrive. Immutable block metadata remains cached. The finalized price worker now targets a five-second start-to-start cadence instead of adding a minute after every capture; slow captures run serially without catch-up bursts. Finalized evidence and the canonical capture/projection path are unchanged. The paired frontend uses the verified confirmed preview for the provisional live candle while finalized historical samples catch up.

Validation: API TypeScript build and full unit suite (including separate budget exhaustion, multi-session capacity and active-deployment snapshot invalidation). Runtime rollout and sustained browser checks passed as recorded below. No schema migration or on-chain transaction is needed.

## Indexer startup outage

The main-branch deployment `13f6d92e-18cb-4bb5-9547-d558f989560a` (commit `d3a5360`) exited before starting ingestion with `Invalid migration manifest entry`. The checkpoint replay migration was in the canonical manifest but absent from `.dockerignore`'s explicit allowlist, so the runtime image omitted it. The SQL had already been applied and the source-tree migration checks did not exercise Docker filtering.

Add the missing allowlist entry, validate the filtered context inside the Docker build before compiling, and name missing entries in startup errors. Do not rename or change already-applied SQL/checksums. Existing container CI also checks the actual image. The portfolio worker stopped shortly after ingestion discovery stopped; restart it only after fresh scans are confirmed.

## Completed devnet rollout

- API `5120cfa3-9e53-4e96-b51e-0600707a120d` and price sampler `aa76a307-b0b1-440e-b4a9-d8af2a373315` deployed successfully. Price logs show serial captures five seconds apart, four markets/six prices, zero unavailable markets.
- Recovered indexer `2ee184d6-5415-4c39-80d5-d592640e663d` passed migration startup and ingested the two swaps missed during the outage. Native account scans and contiguous finalized history scans resumed through current slots; no cursor or coverage was skipped/reset.
- Portfolio worker `572b2a01-6580-4c57-91a4-10430edcb064` restarted after fresh scans. Captures 4784 and 4785 succeeded for five owners, four markets and 54 accounts, advancing to slot 500456812.
- Two simultaneous read-only connected-wallet frontend sessions ran for 120 seconds with zero HTTP errors/429s and no unavailable panels. A follow-up 60-second paired check showed the recovered trades and matching current price, VOB and chart label (1.07022).
- TypeScript/API tests: 161 passed. GitHub container, native integration, gRPC and Timescale history gates passed on d45ad36. No on-chain deployment, identity pin change or signed transaction was required.
