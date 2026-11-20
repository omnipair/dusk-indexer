# Order discovery and activity projection latency

Order capture prefetches the three independent order kinds concurrently (at most
three outstanding discovery requests). Processing and bank-validated detail reads
still advance the original single minimum slot. A prefetched result behind the
current floor is fetched again; the bounded capture can therefore use up to five
rather than three discovery requests. The same owner, PDA, program, Clock,
market-layout and before/after deployment checks remain in force.

Successful exit-order EMA marks can be shared by TP and SL orders only within
one capture, for the same market, debt asset, detail slot and raw market bytes.
The cached mark must still cover the advancing minimum slot. Its original age
is retained; failures are not cached and the next capture reads again. Entry and
hLP previews are unchanged.

Activity projection validates an entire source page and inserts up to 500 rows
in one parameterized statement. Its identity lock, source-row guards, exact
PostgreSQL event timestamps, transaction and replay semantics are unchanged.
Malformed source pages fail before any insert. Source evidence is never replaced
or deleted by this optimization.

## Measurements (2026-11-20)

From the production API container, read-only discovery for the three order kinds
on the controlled owner took 202 ms sequentially and 114 ms with prefetch and
stale-bank refresh. The prefetch timing includes a confirmed-slot read, so this
is an indicative network measurement, not a fixed latency promise. No simulation,
signing or chain writes were performed.

On the actual API/database connection, a session-only temporary table with 500
activity rows took 1023/871 ms for individual inserts and 14/13 ms for bulk inserts.
Complete rows, including timestamp microseconds, matched. This isolates database
round trips and excludes the common source-trigger cost; it is not an end-to-end
projection benchmark. No production table was modified. Local integration timing
was 132 ms before and 177 ms after in single runs, where round trips are cheap;
no local elapsed-time speedup is claimed.

Regression gates cover overlapping discovery, stale-bank refresh/rejection,
same-bank mark sharing, original observation age, capture isolation, RPC failure,
500-row activity batching, exact timestamps, replay and all-or-nothing validation.
