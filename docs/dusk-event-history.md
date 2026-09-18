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

Validation: API build, 152 unit tests and five disposable PostgreSQL history
integration tests, including same-slot pagination, late-backfill stability,
version separation and owner-filter preservation.
