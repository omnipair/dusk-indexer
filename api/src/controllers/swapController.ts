import { Request, Response } from 'express';
import pool from '../config/database';
import { ApiResponse } from '../types';
import { cache } from '../utils/cache';
import { timedQuery } from '../utils/dbQuery';
import { perfMetrics } from '../utils/perfMetrics';
import { isValidAddress, calculateTotalFeesPaid, calculateAPR } from './helpers/controllerBase';

export class SwapController {
  static async getSwaps(req: Request, res: Response): Promise<void> {
    const endpointMetric = req.params.userAddress ? 'users.swaps' : 'swaps';
    const endpointStartedAt = Date.now();
    try {
      const pairAddress = req.params.pairAddress;
      const userAddress = req.params.address || req.params.userAddress;
      const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 100, 1), 100);
      const offset = Math.min(Math.max(parseInt(req.query.offset as string) || 0, 0), 10000);

      if (!pairAddress && !userAddress) {
        res.status(400).json({ success: false, error: 'Either pair address or user address is required' });
        return;
      }
      if ((pairAddress && !isValidAddress(pairAddress)) ||
          (userAddress && !isValidAddress(userAddress))) {
        res.status(400).json({ success: false, error: 'Invalid address format' });
        return;
      }

      const ttlMs = offset <= limit * 2 ? 20 * 1000 : 180 * 1000;
      const cacheKey = `swaps:user:${userAddress || 'all'}:pair:${pairAddress || 'all'}:limit:${limit}:offset:${offset}`;
      const { data, cacheStatus } = await cache.getOrSetWithMeta(cacheKey, ttlMs, async () => {
        let dataQuery: string;
        let queryParams: any[];

        if (pairAddress && userAddress) {
          dataQuery = `
            SELECT *
            FROM swaps
            WHERE pair = $1 AND user_address = $2
            ORDER BY "timestamp" DESC, id DESC
            LIMIT $3 OFFSET $4
          `;
          queryParams = [pairAddress, userAddress, limit + 1, offset];
        } else if (pairAddress) {
          dataQuery = `
            SELECT *
            FROM swaps
            WHERE pair = $1
            ORDER BY "timestamp" DESC, id DESC
            LIMIT $2 OFFSET $3
          `;
          queryParams = [pairAddress, limit + 1, offset];
        } else {
          dataQuery = `
            SELECT *
            FROM swaps
            WHERE user_address = $1
            ORDER BY "timestamp" DESC, id DESC
            LIMIT $2 OFFSET $3
          `;
          queryParams = [userAddress, limit + 1, offset];
        }

        const result = await timedQuery('swaps.history', dataQuery, queryParams);
        const hasNext = result.rows.length > limit;
        const swaps = hasNext ? result.rows.slice(0, limit) : result.rows;

        const responseData: any = {
          swaps,
          pagination: {
            total: null,
            limit,
            offset,
            hasNext
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

      const data = await cache.getOrSet(cacheKey, 10 * 1000, async () => {
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
          )
          SELECT
            EXTRACT(EPOCH FROM time_bucket($1::interval, timestamp))::bigint AS time,
            first(price, timestamp) AS open,
            MAX(price) AS high,
            MIN(price) AS low,
            last(price, timestamp) AS close,
            COALESCE(SUM(volume_usd), 0) AS volume
          FROM priced
          WHERE price IS NOT NULL
          GROUP BY 1
          ORDER BY 1
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
