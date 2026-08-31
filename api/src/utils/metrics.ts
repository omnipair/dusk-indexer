/**
 * Request metrics and build provenance.
 *
 * Deliberately not a Prometheus client library. What an operator needs from
 * this service is a handful of counters and a latency spread, and pulling in a
 * metrics framework to produce them would add a dependency, a scrape format to
 * keep current, and a second place for the service to be misconfigured. The
 * exposition format is simple enough to emit directly and is what any scraper
 * already understands.
 *
 * Latency is kept as buckets rather than a running average. An average hides
 * exactly the tail that matters — a p99 that has tripled while the mean has
 * not moved is the shape of an outage starting.
 */

import { createHash } from 'crypto';

/** Upper bounds in milliseconds, matching the shape of a typical scrape. */
const BUCKETS = [5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000];

interface RouteStats {
  count: number;
  errors: number;
  totalMs: number;
  buckets: number[];
}

const routes = new Map<string, RouteStats>();
const startedAt = Date.now();

function statsFor(route: string): RouteStats {
  let stats = routes.get(route);
  if (!stats) {
    stats = { buckets: new Array(BUCKETS.length + 1).fill(0), count: 0, errors: 0, totalMs: 0 };
    routes.set(route, stats);
  }
  return stats;
}

/**
 * Record one request.
 *
 * The route is the matched pattern, never the concrete path: keying on
 * `/markets/7Rjrf...` would grow a new series per market and make the whole
 * set useless within a day.
 */
export function observeRequest(route: string, statusCode: number, durationMs: number): void {
  const stats = statsFor(route);
  stats.count += 1;
  stats.totalMs += durationMs;
  if (statusCode >= 500) stats.errors += 1;
  const index = BUCKETS.findIndex((bound) => durationMs <= bound);
  stats.buckets[index === -1 ? BUCKETS.length : index] += 1;
}

/** Build and protocol provenance, so a scrape identifies what produced it. */
export function provenance(revision: string, deploymentIdentity: string | null) {
  return {
    protocolRevision: revision,
    deploymentIdentitySha256: deploymentIdentity,
    // Railway supplies the commit; a local run has none, and saying so is
    // better than reporting a plausible-looking placeholder.
    commit: process.env.RAILWAY_GIT_COMMIT_SHA ?? null,
    startedAt: new Date(startedAt).toISOString(),
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
  };
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ');
}

/** Render the collected counters in the text exposition format. */
export function renderMetrics(labels: Record<string, string>): string {
  const common = Object.entries(labels)
    .map(([key, value]) => `${key}="${escapeLabel(value)}"`)
    .join(',');
  const lines: string[] = [
    '# HELP dusk_api_uptime_seconds Seconds since this process started.',
    '# TYPE dusk_api_uptime_seconds gauge',
    `dusk_api_uptime_seconds{${common}} ${Math.floor((Date.now() - startedAt) / 1000)}`,
    '# HELP dusk_api_requests_total Requests served, by matched route.',
    '# TYPE dusk_api_requests_total counter',
  ];

  for (const [route, stats] of routes) {
    const labelSet = `${common},route="${escapeLabel(route)}"`;
    lines.push(`dusk_api_requests_total{${labelSet}} ${stats.count}`);
  }

  lines.push(
    '# HELP dusk_api_request_errors_total Requests answered with a 5xx.',
    '# TYPE dusk_api_request_errors_total counter',
  );
  for (const [route, stats] of routes) {
    const labelSet = `${common},route="${escapeLabel(route)}"`;
    lines.push(`dusk_api_request_errors_total{${labelSet}} ${stats.errors}`);
  }

  lines.push(
    '# HELP dusk_api_request_duration_ms Request latency, in milliseconds.',
    '# TYPE dusk_api_request_duration_ms histogram',
  );
  for (const [route, stats] of routes) {
    const labelSet = `${common},route="${escapeLabel(route)}"`;
    let cumulative = 0;
    for (const [index, bound] of BUCKETS.entries()) {
      cumulative += stats.buckets[index] ?? 0;
      lines.push(`dusk_api_request_duration_ms_bucket{${labelSet},le="${bound}"} ${cumulative}`);
    }
    cumulative += stats.buckets[BUCKETS.length] ?? 0;
    lines.push(`dusk_api_request_duration_ms_bucket{${labelSet},le="+Inf"} ${cumulative}`);
    lines.push(`dusk_api_request_duration_ms_sum{${labelSet}} ${Math.round(stats.totalMs)}`);
    lines.push(`dusk_api_request_duration_ms_count{${labelSet}} ${stats.count}`);
  }

  return `${lines.join('\n')}\n`;
}

/** Stable short id for a request, for correlating a log line to a trace. */
export function requestId(): string {
  return createHash('sha256')
    .update(`${Date.now()}:${Math.random()}`)
    .digest('hex')
    .slice(0, 16);
}
