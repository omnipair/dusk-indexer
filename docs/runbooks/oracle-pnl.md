# Oracle PnL and price overlay rollout

The wallet snapshot now adds `oracleValuations`. The basis is
`symmetric-risk-ema.v1`: collateral at the program's clock-evaluated symmetric
risk EMA, less accrued debt and original margin. Signed equity is retained when
collateral no longer covers debt. It is unrealized PnL, not a withdrawal amount
or a claim that the connected wallet owes the displayed deficit.

For each market, `preview_market` evaluates its lazy time-dependent state and
returns the positions at that same confirmed bank. One preview values up to
20 positions. The final wallet inventory read still rejects mutations during
capture. Debt uses aggregate share-burn rounding; base and quote use their own
EMA, never an inverted display price. A failed preview is unavailable, not zero.
Existing close valuations stay available for backward compatibility and retain
their execution/receipt meaning.

Candle responses add `oracleClose` from the close witness's verified saved
preview. There is no database migration or rewritten historical projection.
An older capture with a zero EMA leaves that Oracle point unavailable. No spot
substitution or synthetic client-side EMA is used.

Deploy the API and gRPC image before the matching webapp update. Existing shared
market/wallet payloads are captured at a two-second minimum interval and expire
after 15 seconds; the stream hub wakes periodically even without a trade.
This is a target cadence, not a per-slot guarantee: capture time and upstream
availability can delay a frame. Finalized candle capture supplies history;
confirmed market previews supply its live suffix. No new browser RPC polling
is required. A failed capture never extends a prior snapshot's timestamp.

Verify after deployment:

1. The wallet frame includes one Oracle outcome per open position, and positions
   with rejected normal closes can still return signed `equityRaw` / `pnlRaw`.
2. Base and quote candle endpoints include Oracle samples whose capture id,
   hash, timestamp and source slot match their close witness.
3. Quiet-market frames continue advancing their observed bank/clock. EMA may be
   unchanged when it has already converged to the mark.
4. Deploy the separate keeper compute-budget fix and check simulation outcomes
   and confirmed liquidation receipts. An Online service alone is insufficient.

The protocol release pinned here is `932018a`. The later Dusk PR #33 adds an EMA
confirmation to leverage risk gates, but is not part of that deployed release.
This API change does not deploy it or alter liquidation eligibility. Do not
infer Liquidating or Liquidated from a failed close or negative oracle equity;
those statuses require execution evidence.
