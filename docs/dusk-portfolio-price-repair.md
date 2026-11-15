# Historical portfolio price repair

The existing Dusk price worker refreshes live quotes every 30 seconds and checks
for missing historical portfolio valuations every five minutes, including while
markets are idle. It uses the existing `BIRDEYE_API_KEY` from that service's
runtime secret. No new service or signing key is involved.

## Evidence and scope

Original account captures, checkpoints, slots, owners, token amounts, debt and
price references remain immutable. Birdeye minute prices are stored separately
in `dusk_ingestion.historical_price_points`, with provider timestamps, actual
fetch times, request bounds, raw-token units and a hash of the evidence.

A price may supplement only a missing USD leg, at or before that component's
capture time and less than one minute old. Captures wait at least two minutes
for a completed provider interval. Configured references and already-valued
components are preserved. Missing market previews, quantities or debt state
cannot be repaired with an external price. No present-day price fallback or
interpolation is used.

Fully valued owner checkpoints are appended to `portfolio_price_repairs`.
Database guards reject changed position state or missing dated evidence. API
history reads the effective view, retaining the original capture identifier
and time. `coverage.historicalPriceRepair` identifies the reconstruction and
its dated price evidence; `coverage.repairedSnapshots` counts repaired rows.
The history selection hash includes valuation revisions so an unchanged set of
captures still invalidates after repair. Source history completeness is never
promoted merely because USD prices have become available.

The repair does not change current quotes, protocol risk prices, swaps, program
accounts, event candles or historical fee-attribution data.

## Bounded automatic retry

Each cycle selects at most 100 due captures in a six-hour span and makes at most
four provider range calls, with five-second request timeouts. Cached minute
prices are reused across captures and owners. A session advisory lock prevents
overlap across workers. Original evidence is verified again before a repair is
written. Contradictory source evidence stops the worker; transient provider
failures leave the gap available for retry.

Unresolved captures back off from five minutes up to six hours. A failed older
capture does not block new gaps during its backoff. Restarting the worker
retains cached prices, completed repairs and retry state. Live price refresh
runs first; repair runs only on a due wake.

## Release and one-shot backfill

1. Apply manifest migration `055_dusk_portfolio_price_repairs.sql` before starting
   the new API or price-worker image. The old application continues to read its
   original checkpoints during the migration.
2. Seed provider credentials with the existing `seed-provider-prices.mjs`
   Railway-to-Secrets-Manager helper. Values must stay out of logs, files and
   process arguments. Keep unrelated runtime fields and signer secrets intact.
3. Build and run the exact reviewed API image. The one-shot command defaults to
   a read/fetch-only preview:

   ```sh
   node dist/scripts/duskPortfolioPriceRepair.js --limit 100 --max-requests 4
   node dist/scripts/duskPortfolioPriceRepair.js --execute --limit 100 --max-requests 4
   ```

   The local npm helper is `npm run repair:native-portfolio-prices -- ...`.
   Limits are bounded to 1–500 captures and 0–8 HTTP requests. A zero request
   budget permits cache-only repair. Normal production use should retain the
   default four-request budget.
4. Compare original capture/checkpoint counts and content hashes before/after;
   they must be unchanged. Check repair counts, remaining missing-price rows,
   retry state and `Dusk historical portfolio price repair` worker logs.
5. Read `/api/dusk/v1/owners/<owner>/portfolio-snapshots` and verify dated
   components, unchanged source slots/times, changed selection hash, repaired
   coverage and zero unvalued snapshots where sufficient evidence exists.
   Verify the portfolio chart in the production app.

A rollback of the application leaves the appended evidence intact and reads
the original checkpoints again. Do not remove or rewrite historical evidence
to force a recovery.
