import { QueryResult } from 'pg';
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
