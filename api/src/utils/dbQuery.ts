import { PoolClient, QueryResult, QueryResultRow } from 'pg';
import pool from '../config/database';
import { perfMetrics } from './perfMetrics';

export async function timedQuery(
  queryName: string,
  queryText: string,
  params: any[] = []
): Promise<QueryResult<any>> {
  const startedAt = Date.now();
  try {
    return await pool.query(queryText, params);
  } finally {
    perfMetrics.recordDbQuery(queryName, Date.now() - startedAt);
  }
}

/** Preserve the caller's transaction/snapshot while using the shared timings. */
export async function timedClientQuery<T extends QueryResultRow = any>(
  client: PoolClient, queryName: string, queryText: string, params: unknown[] = [],
): Promise<QueryResult<T>> {
  const startedAt = performance.now();
  try { return await client.query<T>(queryText, params); }
  finally { perfMetrics.recordDbQuery(queryName, performance.now() - startedAt); }
}
