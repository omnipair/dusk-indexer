# Mainnet wallet capture latency

Production profiling on 2026-11-15 separated ingestion, HTTP delivery and wallet calculation:

- A recent opening was recorded 0.773 seconds after its independently checked RPC block time. Block time has one-second resolution; this is a sample, not a general SLA.
- Three warm wallet HTTP requests completed in 0.29–0.50 seconds. Their snapshots were 3.5–6.3 seconds old, so HTTP latency alone concealed the time needed to calculate a new frame.
- Two fresh wallet captures took 4.37–4.69 seconds for two leverage positions, a borrow and hLP holdings. Close valuations and order reads took about 2.7–3.0 seconds inside those captures. Cash-flow history took 74–95 milliseconds and both positions had available basis.
- CloudWatch API service CPU was near 100% of its task allowance throughout 08:50–09:20 UTC. The task cgroup allowed 75,000 microseconds per 100,000-microsecond period; all 50 periods in a five-second sample were throttled.

The API task now reserves 1,280 CPU units: one core for the application and its unsigned simulation/depth processes, plus 256 units for Service Connect. Its memory remains unchanged. All twelve Singapore tasks reserve 2,048 units in total, fitting the existing two-core host; no extra steady host, service or signer is introduced. Existing managed rolling replacement capacity is retained. The [cost model](../deploy/aws/infra/shared-cost-estimate.json) increases the variable CPU-credit reserve from 100 to 730 vCPU-hours: $383.40/month at all stated assumptions, within the existing $400 planning budget. Metered usage can still exceed the estimate.

Wallet account discovery overlaps independent indexed holdings reads. LP performance history overlaps live valuation previews, retaining the original observation cutoff. The complete batch still waits for every required result, validates the final position inventory, enforces source-slot floors and preserves the original expiry. No partial/invented valuation is published; stream cadence and RPC request counts are unchanged.

Release validation must compare warm capture durations and CPU throttling after the rollout, verify both current positions and their cash-flow basis, and exercise the wallet stream alongside the native depth stream. Do not open a financial position solely to measure latency.
