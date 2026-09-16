# Quote-history latency — 2026-09-16

The API parsed the pinned IDL and constructed a complete Anchor BorshCoder for
**each** saved candle witness. The same three-day/15-minute query verified 414
witnesses for 206 candles. On the deployed devnet instance, witness verification
alone took 3.4–4.0 seconds; database queries took about 0.2–0.3 seconds.

The change reuses the decoder's immutable layouts for the process lifetime,
matching the existing immutable protocol pin. It additionally verifies the IDL
file's raw hash against the active pin before constructing the decoder. It does
not cache source rows, prices, verification results or deployment envelopes.
Every source still passes its identity, slot, content hash, preview hash,
market PDA, saved reference policy and decoded projection checks on every read.

## Same-data comparison

`comparison.jsonl` was recorded by a separate Node process inside the existing
devnet API container. It loaded the candidate decoder module in memory; it did
not modify the running service or its files. All database transactions were
REPEATABLE READ READ ONLY. The history window was fixed before all three reads.
The optimized responses were deeply equal to the baseline, including coverage,
source witnesses and selectionHash.

| Run | Total | Source verification | Identity before/after |
| --- | ---: | ---: | ---: |
| Baseline, cold process | 7.272s | 4.024s | 2.291s / 0.555s |
| Shared decoder, first read | 1.133s | 0.407s | 0.240s / 0.236s |
| Shared decoder, subsequent read | 1.059s | 0.360s | 0.233s / 0.238s |

The first baseline includes a cold program-binary attestation, so total timings
are not a pure decoder-only comparison. The isolated verification cost improves
by approximately 10×. A preceding baseline with warm identity observations took
4.067s total, including 3.370s verification. Remote HTTP and full browser-adapter
measurements after deployment are recorded separately.

## Validation

- TypeScript build and all 148 existing API unit checks passed.
- All 16 existing price and quote-history PostgreSQL integration checks passed
  against a disposable local database with the canonical migration manifest.
  These include forged projection/source rejection, contradictory finalized
  banks, both quote directions, same-bank deduplication, replay and historical
  deployment boundaries.
- No migration, worker reconfiguration or signed transaction is required.

## Deployed verification

Commit `13f44252b2b6a1976829309982615812697ac135` is deployed to the `dusk-api`
service in Railway project `dusk-devnet` (deployment
`4204da3c-bb38-4c96-8372-a32f17e5e164`). Railway calls this devnet project's
environment `production`; both `DUSK_CLUSTER` and the live deployment envelope
confirm devnet, with genesis `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`.
The live envelope reported the new build revision at 2026-09-16T10:31:13Z.

`deployed-app-read.jsonl` runs the webapp's actual history adapter and strict
SDK/RPC read boundary from the developer machine against the public API:

| Read | History HTTP | Full chart read | Candles |
| --- | ---: | ---: | ---: |
| 1 | 0.510s | 1.855s | 206 |
| 2 | 1.101s | 2.548s | 207 |
| 3 | 1.073s | 2.467s | 207 |

Before this fix, the same three-day query took 4.3–10.8s at the HTTP boundary
and 5.9–12.3s through the app adapter. These are observed samples, not a latency
SLA; cold program attestation and RPC/network delays can still add latency.
No protocol or keeper deployment changed. PR #9 retains the API fix for merging
into main; the devnet service was deployed from the reviewed feature commit.
