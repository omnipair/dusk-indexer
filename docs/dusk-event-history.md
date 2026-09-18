# Native event history

`GET /api/dusk/v1/history/events?version=2` includes `HlpOpened`, `HlpClosed`
and `YieldClaimed` alongside the existing market activity events. The default
remains version 1, with its unchanged supported-event list and cursor scope,
so the API can deploy before its consumers. Unknown versions return 400.

Version 2 returns `dusk-event-history.v2`. Cursors bind the selected event list,
full deployment identity, market/owner/category, range and observation watermark.
A version 1 cursor cannot be reused in version 2. Closed-position queries still
select only full leverage closes and liquidations, filtered by position owner.

All records come from finalized canonical events, retain full CPI-path identity,
and require one matching event-time projection. Missing timestamps, conflicting
finalized observations and mismatched stream records fail the read. hLP events
do not carry `MarketEventMetadata` in the pinned native IDL; clients must validate
their outer canonical provenance rather than invent that metadata.

Amounts retain native semantics: hLP deposits record net reserve credit,
withdrawals record net owner credit, and yield claims carry both gross source
amounts and net recipient credit. These events are not swaps and must not be
counted in trading volume. They do not establish historical cost basis or prove
gap-free history. `historyRangeComplete` remains false.

Validation and reproducible query-plan evidence are recorded in
[the native-history performance report](evidence/native-history-performance-2026-09-18/README.md).

Wallet history opts into `version=2&category=activity&owner=<wallet>`. The
owner/category pair is mandatory. Swaps select `trader`; borrowing liquidations
select `borrower` or `liquidator`; leverage liquidations select `owner` or
`liquidator`; the remaining supported receipts select `owner`. Filtering happens
before keyset pagination. Cursors cannot cross owners, categories or versions.
This feed provides native token receipts, not historical USD contributions or
complete lifetime coverage.


## Performance and deployment

Migration `042_dusk_event_history_performance.sql` must run before the API is
updated. It adds participant/market/keyset indexes and transactionally maintained
revision and conflict state. The API checks that state before every cached read,
including when database notifications are missed. Page queries retain their
canonical and stream-evidence checks; cache hits still pass the route's fresh
before/after deployment verification. A conflict remains a halt even outside the
selected page.

Owner and liquidator branches are separately filtered and bounded before merging.
The cache is limited to 128 pages, uses 20-second initial-page and 60-second
cursor-page TTLs, and coalesces identical concurrent reads. Keys include the
full deployment/selection scope, committed revision, watermark, cursor and limit.
Notifications and listener reconnects invalidate pages immediately. Failures and
invalidated in-flight results cannot repopulate the cache. Keep `until` fixed for
cursor pagination and repeated reads of the same history window.

Shared performance metrics expose named state/page query timings and cache
hit/miss/coalesced counts. `npm run benchmark:native-activity` measures the native
HTTP endpoint; the opt-in disposable DB mode also compares the previous reader,
asserts identical results, and captures sparse/dense-wallet query plans.
