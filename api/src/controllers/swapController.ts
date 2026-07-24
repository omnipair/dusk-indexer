import { Request, Response } from 'express';
import pool from '../config/database';
import { ApiResponse } from '../types';
import { cache } from '../utils/cache';
import { timedQuery } from '../utils/dbQuery';
import { perfMetrics } from '../utils/perfMetrics';
import { isValidAddress, calculateTotalFeesPaid, calculateAPR } from './helpers/controllerBase';

export interface SwapHistoryCursor {
  timestamp: string;
  id: number;
}

export interface SwapHistoryQueryInput {
  pairAddress?: string;
  userAddress?: string;
  limit: number;
  offset: number;
  from?: string;
  to?: string;
  cursor?: SwapHistoryCursor;
}

function parseDateQuery(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} must be an ISO-8601 date or Unix timestamp`);
  }

  const trimmed = value.trim();
  const numericValue = Number(trimmed);
  const date = Number.isFinite(numericValue)
    ? new Date(numericValue < 10_000_000_000 ? numericValue * 1000 : numericValue)
    : new Date(trimmed);

  if (Number.isNaN(date.getTime())) {
    throw new Error(`${name} must be an ISO-8601 date or Unix timestamp`);
  }
  return date.toISOString();
}

export function encodeSwapHistoryCursor(cursor: SwapHistoryCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeSwapHistoryCursor(value: unknown): SwapHistoryCursor | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('cursor is invalid');
  }

  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    const timestamp = parseDateQuery(parsed.timestamp, 'cursor timestamp');
    const id = Number(parsed.id);
    if (!timestamp || !Number.isInteger(id) || id < 0) throw new Error();
    return { timestamp, id };
  } catch {
    throw new Error('cursor is invalid');
  }
}

export function parseSwapHistoryRange(query: Request['query']): {
  from?: string;
  to?: string;
  cursor?: SwapHistoryCursor;
} {
  const from = parseDateQuery(query.from, 'from');
  const to = parseDateQuery(query.to, 'to');
  if (from && to && new Date(from).getTime() >= new Date(to).getTime()) {
    throw new Error('from must be earlier than to');
  }
  return { from, to, cursor: decodeSwapHistoryCursor(query.cursor) };
}

export function buildSwapHistoryQuery(input: SwapHistoryQueryInput): {
  query: string;
  params: any[];
} {
  const params: any[] = [];
  const filters: string[] = [];
  const addParam = (value: any): string => {
    params.push(value);
    return `$${params.length}`;
  };

  if (input.pairAddress) filters.push(`pair = ${addParam(input.pairAddress)}`);
  if (input.userAddress) filters.push(`user_address = ${addParam(input.userAddress)}`);
  if (input.from) filters.push(`"timestamp" >= ${addParam(input.from)}::timestamptz`);
  if (input.to) filters.push(`"timestamp" < ${addParam(input.to)}::timestamptz`);
  if (input.cursor) {
    const timestampParam = addParam(input.cursor.timestamp);
    const idParam = addParam(input.cursor.id);
    filters.push(`("timestamp", id) < (${timestampParam}::timestamptz, ${idParam})`);
  }

  const limitParam = addParam(input.limit + 1);
  const offsetParam = addParam(input.cursor ? 0 : input.offset);
  return {
    query: `
      SELECT *
      FROM swaps
      WHERE ${filters.join(' AND ')}
      ORDER BY "timestamp" DESC, id DESC
      LIMIT ${limitParam} OFFSET ${offsetParam}
    `,
    params,
  };
}

export class SwapController {
  static async getSwaps(req: Request, res: Response): Promise<void> {
    const endpointMetric = req.params.userAddress ? 'users.swaps' : 'swaps';
    const endpointStartedAt = Date.now();
    try {
      const pairAddress = req.params.pairAddress;
      const userAddress = req.params.address || req.params.userAddress;
      const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 100, 1), 100);
      const offset = Math.min(Math.max(parseInt(req.query.offset as string) || 0, 0), 10000);
      let range: ReturnType<typeof parseSwapHistoryRange>;
      try {
        range = parseSwapHistoryRange(req.query);
      } catch (error) {
        res.status(400).json({ success: false, error: (error as Error).message });
        return;
      }

      if (!pairAddress && !userAddress) {
        res.status(400).json({ success: false, error: 'Either pair address or user address is required' });
        return;
      }
      if ((pairAddress && !isValidAddress(pairAddress)) ||
          (userAddress && !isValidAddress(userAddress))) {
        res.status(400).json({ success: false, error: 'Invalid address format' });
        return;
      }

      const ttlMs = offset <= limit * 2 && !range.cursor ? 20 * 1000 : 180 * 1000;
      const cacheKey = [
        `swaps:user:${userAddress || 'all'}`,
        `pair:${pairAddress || 'all'}`,
        `limit:${limit}`,
        `offset:${offset}`,
        `from:${range.from || 'none'}`,
        `to:${range.to || 'none'}`,
        `cursor:${req.query.cursor || 'none'}`,
      ].join(':');
      const { data, cacheStatus } = await cache.getOrSetWithMeta(cacheKey, ttlMs, async () => {
        const { query: dataQuery, params: queryParams } = buildSwapHistoryQuery({
          pairAddress,
          userAddress,
          limit,
          offset,
          ...range,
        });

        const result = await timedQuery('swaps.history', dataQuery, queryParams);
        const hasNext = result.rows.length > limit;
        const swaps = hasNext ? result.rows.slice(0, limit) : result.rows;
        const lastSwap = swaps[swaps.length - 1];
        const nextCursor = hasNext && lastSwap
          ? encodeSwapHistoryCursor({
              timestamp: new Date(lastSwap.timestamp).toISOString(),
              id: Number(lastSwap.id),
            })
          : null;

        const responseData: any = {
          swaps,
          pagination: {
            total: null,
            limit,
            offset,
            hasNext,
            nextCursor
          }
        };
        if (pairAddress) responseData.pairAddress = pairAddress;
        if (userAddress) responseData.userAddress = userAddress;
        return responseData;
      });

      perfMetrics.recordCacheLookup(endpointMetric, cacheStatus);
      res.json({ success: true, data });
    } catch (error) {
      console.error('Error fetching swaps:', error);
      const response: ApiResponse = {
        success: false,
        error: 'Failed to fetch swaps'
      };
      res.status(500).json(response);
    } finally {
      perfMetrics.recordEndpointLatency(endpointMetric, Date.now() - endpointStartedAt);
    }
  }

  static async getSwapVolume(req: Request, res: Response): Promise<void> {
    try {
      const pairAddress = req.params.pairAddress;
      const hours = req.params.hours ? parseInt(req.params.hours) : 24;

      if (!pairAddress || !isValidAddress(pairAddress)) {
        res.status(400).json({ success: false, error: 'Valid pair address is required' });
        return;
      }

      if (isNaN(hours) || hours <= 0 || hours > 720) {
        res.status(400).json({ success: false, error: 'Invalid hours parameter. Must be between 1 and 720.' });
        return;
      }

      const data = await cache.getOrSet(`swap_volume_${pairAddress}_${hours}hrs`, 15 * 1000, async () => {
        const now = Math.floor(Date.now() / 1000);
        const timestamp = now - (hours * 60 * 60);

        const result = await pool.query(`
          SELECT 
            SUM(CASE WHEN is_token0_in = true THEN amount_in::numeric ELSE amount_out::numeric END) as total_volume0,
            SUM(CASE WHEN is_token0_in = false THEN amount_in::numeric ELSE amount_out::numeric END) as total_volume1,
            SUM(COALESCE(volume_usd, 0)) as total_volume_usd
          FROM swaps 
          WHERE timestamp > to_timestamp($1) AND pair = $2
        `, [timestamp, pairAddress]);

        return {
          volume0: result.rows[0].total_volume0 || '0',
          volume1: result.rows[0].total_volume1 || '0',
          volumeUsd: result.rows[0].total_volume_usd || '0',
          period: `${hours}hrs`,
          hours,
          pairAddress
        };
      });

      res.json({ success: true, data });
    } catch (error) {
      console.error('Error fetching swap volume:', error);
      res.status(500).json({ success: false, error: 'Failed to fetch swap volume' });
    }
  }

  static async getChartPrices(req: Request, res: Response): Promise<void> {
    try {
      const pairAddress = req.params.pairAddress;
      const hours = req.params.hours ? parseInt(req.params.hours) : 24;

      if (!pairAddress || !isValidAddress(pairAddress)) {
        res.status(400).json({ success: false, error: 'Valid pair address is required' });
        return;
      }

      if (isNaN(hours) || hours <= 0 || hours > 720) {
        res.status(400).json({ success: false, error: 'Invalid hours parameter. Must be between 1 and 720.' });
        return;
      }

      let bucketInterval: string;
      let intervalLabel: string;

      if (hours <= 24) {
        bucketInterval = '1 minute';
        intervalLabel = '1 minute';
      } else if (hours <= 168) {
        bucketInterval = '1 hour';
        intervalLabel = '1 hour';
      } else {
        bucketInterval = '1 day';
        intervalLabel = '1 day';
      }

      const data = await cache.getOrSet(`chart_prices_${pairAddress}_${hours}hrs`, 10 * 1000, async () => {
        const timeInterval = `${hours} hours`;
        const result = await pool.query(`
          SELECT
            time_bucket_gapfill($1, timestamp,
              start => now() - interval '${timeInterval}',
              finish => now()
            ) AS bucket,
            LOCF(AVG(reserve1::numeric / NULLIF(reserve0,0))) AS avg_price
          FROM swaps
          WHERE timestamp >= now() - interval '${timeInterval}' AND pair = $2
          GROUP BY bucket
          ORDER BY bucket
        `, [bucketInterval, pairAddress]);

        const latestPriceResult = await pool.query(`
          SELECT reserve1::numeric / NULLIF(reserve0,0) AS latest_price
          FROM swaps
          WHERE pair = $1
          ORDER BY timestamp DESC
          LIMIT 1
        `, [pairAddress]);

        return {
          prices: result.rows,
          latestPrice: latestPriceResult.rows[0]?.latest_price || null,
          period: `${hours} hours`,
          interval: intervalLabel,
          hours: hours,
          pairAddress
        };
      });

      res.json({ success: true, data });
    } catch (error) {
      console.error('Error fetching chart prices:', error);
      const response: ApiResponse = {
        success: false,
        error: 'Failed to fetch chart prices'
      };
      res.status(500).json(response);
    }
  }

  static async getCandles(req: Request, res: Response): Promise<void> {
    try {
      const pairAddress = req.params.pairAddress;
      const resolution = parseInt(req.query.resolution as string) || 15;
      const from = parseInt(req.query.from as string);
      const to = parseInt(req.query.to as string);

      if (!pairAddress || !isValidAddress(pairAddress)) {
        res.status(400).json({ success: false, error: 'Valid pair address is required' });
        return;
      }

      const allowedResolutions = [1, 5, 15, 60, 240, 1440];
      if (!allowedResolutions.includes(resolution)) {
        res.status(400).json({ success: false, error: `Invalid resolution. Allowed: ${allowedResolutions.join(', ')} (minutes)` });
        return;
      }

      if (!from || !to || isNaN(from) || isNaN(to) || from >= to) {
        res.status(400).json({ success: false, error: 'Valid from/to Unix timestamps (seconds) are required, with from < to' });
        return;
      }

      const bucketInterval = `${resolution} minutes`;
      const cacheKey = `candles_${pairAddress}_${resolution}_${from}_${to}`;

      const data = await cache.getOrSet(cacheKey, 1000, async () => {
        const result = await pool.query(`
          WITH priced AS (
            SELECT
              timestamp,
              reserve1::numeric / NULLIF(reserve0::numeric, 0) AS price,
              volume_usd
            FROM swaps
            WHERE pair = $2
              AND timestamp >= to_timestamp($3::bigint)
              AND timestamp < to_timestamp($4::bigint)
              AND reserve0 > 0
              AND reserve1 IS NOT NULL
          ),
          filled AS (
            SELECT
              time_bucket_gapfill(
                $1::interval,
                timestamp,
                to_timestamp($3::bigint),
                to_timestamp($4::bigint)
              ) AS bucket,
              locf(last(price, timestamp)) AS filled_close,
              MAX(price) AS high_raw,
              MIN(price) AS low_raw,
              SUM(volume_usd) AS volume_raw
            FROM priced
            GROUP BY bucket
          ),
          trimmed AS (
            SELECT * FROM filled WHERE filled_close IS NOT NULL
          )
          SELECT
            EXTRACT(EPOCH FROM bucket)::bigint AS time,
            COALESCE(LAG(filled_close) OVER (ORDER BY bucket), filled_close) AS open,
            GREATEST(
              COALESCE(high_raw, filled_close),
              COALESCE(LAG(filled_close) OVER (ORDER BY bucket), filled_close)
            ) AS high,
            LEAST(
              COALESCE(low_raw, filled_close),
              COALESCE(LAG(filled_close) OVER (ORDER BY bucket), filled_close)
            ) AS low,
            filled_close AS close,
            COALESCE(volume_raw, 0) AS volume
          FROM trimmed
          ORDER BY bucket
        `, [bucketInterval, pairAddress, from, to]);

        return {
          candles: result.rows.map((r: any) => ({
            time: Number(r.time),
            open: Number(r.open),
            high: Number(r.high),
            low: Number(r.low),
            close: Number(r.close),
            volume: Number(r.volume),
          })),
          pairAddress,
          resolution: String(resolution),
        };
      });

      res.json({ success: true, data });
    } catch (error) {
      console.error('Error fetching candles:', error);
      res.status(500).json({ success: false, error: 'Failed to fetch candles' });
    }
  }

  static async getFeePaid(req: Request, res: Response): Promise<void> {
    try {
      const pairAddress = req.params.pairAddress;
      const hours = req.params.hours ? parseInt(req.params.hours) : 24;

      if (!pairAddress || !isValidAddress(pairAddress)) {
        res.status(400).json({ success: false, error: 'Valid pair address is required' });
        return;
      }

      if (isNaN(hours) || hours <= 0 || hours > 720) {
        res.status(400).json({ success: false, error: 'Invalid hours parameter. Must be between 1 and 720.' });
        return;
      }

      const data = await cache.getOrSet(`fee_paid_${pairAddress}_${hours}hrs`, 15 * 1000, async () => {
        const feeData = await calculateTotalFeesPaid(pairAddress, hours);
        return { ...feeData, hours, pairAddress };
      });

      res.json({ success: true, data });
    } catch (error) {
      console.error('Error fetching fee paid:', error);
      res.status(500).json({ success: false, error: 'Failed to fetch fee paid' });
    }
  }

  static async getAPR(req: Request, res: Response): Promise<void> {
    try {
      const pairAddress = req.params.pairAddress;

      if (!pairAddress || !isValidAddress(pairAddress)) {
        res.status(400).json({ success: false, error: 'Valid pair address is required' });
        return;
      }

      const data = await cache.getOrSet(`apr_data_${pairAddress}`, 10 * 1000, async () => {
        const aprData = await calculateAPR(pairAddress);
        return { ...aprData, pairAddress };
      });

      res.json({ success: true, data });
    } catch (error) {
      console.error('Error calculating APR:', error);
      res.status(500).json({ success: false, error: 'Failed to calculate APR' });
    }
  }
}
