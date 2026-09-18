# Realtime read pressure and price freshness — 2026-09-19

A Leverage page refreshes multiple read families on native stream hints. The previous 100 data / 600 identity requests per minute per IP did not accommodate two connected sessions and their fresh API/RPC identity brackets. The frontend also allowed each change burst to revalidate the whole page every 250ms.

The paired frontend change bounds change-driven refreshes to two seconds and retains a pending hint during reads. API defaults are now 1,200 data / 3,600 identity requests per minute per IP, with separate configurable budgets. Rate-limit rejections now pass through request metrics and structured failure logging. No deployment, schema, slot or transaction check is removed.

Current market snapshots are invalidated alongside other projections when active-deployment notifications arrive. Immutable block metadata remains cached. The finalized price worker now targets a five-second start-to-start cadence instead of adding a minute after every capture; slow captures run serially without catch-up bursts. Finalized evidence and the canonical capture/projection path are unchanged. The paired frontend uses the verified confirmed preview for the provisional live candle while finalized historical samples catch up.

Validation: API TypeScript build and full unit suite (including separate budget exhaustion, multi-session capacity and active-deployment snapshot invalidation). Runtime deployment and sustained browser evidence will be recorded after rollout. No schema migration or on-chain transaction is needed.
