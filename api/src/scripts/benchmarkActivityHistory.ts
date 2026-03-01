/**
 * Benchmark helper for activity-history endpoints.
 * Run against a live API:
 *   API_BASE_URL=http://localhost:3000 USER_ADDRESS=... npm run benchmark:activity
 */

type BenchmarkResult = {
  endpoint: string;
  count: number;
  p50: number;
  p95: number;
  max: number;
  errors: number;
};

function percentile(values: number[], q: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.floor((sorted.length - 1) * q);
  return Math.round(sorted[idx]);
}

async function timedFetch(url: string): Promise<number> {
  const startedAt = Date.now();
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  await response.json();
  return Date.now() - startedAt;
}

async function runBenchmark(endpoint: string, iterations: number): Promise<BenchmarkResult> {
  const values: number[] = [];
  let errors = 0;

  for (let i = 0; i < iterations; i += 1) {
    try {
      values.push(await timedFetch(endpoint));
    } catch (error) {
      errors += 1;
      console.error('[benchmark] request failed', error);
    }
  }

  return {
    endpoint,
    count: values.length,
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    max: values.length > 0 ? Math.max(...values) : 0,
    errors,
  };
}

async function main(): Promise<void> {
  const baseUrl = process.env.API_BASE_URL || 'http://localhost:3000';
  const userAddress = process.env.USER_ADDRESS;
  const poolAddress = process.env.POOL_ADDRESS;
  const iterations = Number(process.env.BENCH_ITERATIONS || '30');

  if (!userAddress) {
    throw new Error('USER_ADDRESS is required');
  }

  const encodedUser = encodeURIComponent(userAddress);
  const endpoints = [
    `${baseUrl}/api/v1/users/${encodedUser}/swaps?limit=50&offset=0`,
    `${baseUrl}/api/v1/users/${encodedUser}/lending-events?limit=50&offset=0`,
    `${baseUrl}/api/v1/users/${encodedUser}/activity?categories=swaps,liquidity,lending&limit=50&offset=0&sort=recent`,
  ];
  if (poolAddress) {
    endpoints.splice(1, 0, `${baseUrl}/api/v1/users/${encodedUser}/liquidity-events?limit=50&offset=0&poolAddress=${encodeURIComponent(poolAddress)}`);
  }

  console.log(`[benchmark] base=${baseUrl} iterations=${iterations}`);
  console.log('[benchmark] warm-up pass');
  for (const endpoint of endpoints) {
    try {
      await timedFetch(endpoint);
    } catch (error) {
      console.error(`[benchmark] warm-up failed for ${endpoint}`, error);
    }
  }

  console.log('[benchmark] measured pass');
  const results: BenchmarkResult[] = [];
  for (const endpoint of endpoints) {
    results.push(await runBenchmark(endpoint, iterations));
  }

  for (const result of results) {
    console.log(
      `[benchmark] endpoint=${result.endpoint} count=${result.count} errors=${result.errors} p50_ms=${result.p50} p95_ms=${result.p95} max_ms=${result.max}`
    );
  }
}

main().catch((error) => {
  console.error('[benchmark] failed', error);
  process.exit(1);
});
