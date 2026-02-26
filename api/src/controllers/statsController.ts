import { Request, Response } from 'express';
import pool from '../config/database';
import { cache } from '../utils/cache';
import { PoolController } from './poolController';
import { fetchTokenPrices } from '../services/jupiterPriceService';

export class StatsController {
  static async getStats(_req: Request, res: Response): Promise<void> {
    try {
      const [tvlData, volumeData] = await Promise.all([
        StatsController.computeTvl(),
        StatsController.computeVolume(),
      ]);

      res.json({
        success: true,
        data: {
          tvl: tvlData.tvl,
          total_volume: volumeData.totalVolume,
          volume_24h: volumeData.volume24h,
          pool_count: tvlData.poolCount,
        },
      });
    } catch (error) {
      console.error('Error fetching stats:', error);
      res.status(500).json({ success: false, error: 'Failed to fetch stats' });
    }
  }

  private static async computeTvl(): Promise<{ tvl: number; poolCount: number }> {
    const allPools = await PoolController.fetchAllPools(false);

    const uniqueMints = new Set<string>();
    for (const p of allPools) {
      if (p.token0.address) uniqueMints.add(p.token0.address);
      if (p.token1.address) uniqueMints.add(p.token1.address);
    }

    const prices = await fetchTokenPrices(Array.from(uniqueMints));

    let tvl = 0;
    for (const p of allPools) {
      const reserve0 = parseFloat(p.reserves.token0);
      const reserve1 = parseFloat(p.reserves.token1);
      const price0 = prices.get(p.token0.address)?.price;
      const price1 = prices.get(p.token1.address)?.price;

      if (price0 && price1) {
        tvl += reserve0 * price0 + reserve1 * price1;
      } else if (price0) {
        tvl += reserve0 * price0 * 2;
      } else if (price1) {
        tvl += reserve1 * price1 * 2;
      }
    }

    return { tvl, poolCount: allPools.length };
  }

  static async getVolumeChart(req: Request, res: Response): Promise<void> {
    const VALID_TIMEFRAMES = ['7d', '30d', 'all'] as const;
    type Timeframe = typeof VALID_TIMEFRAMES[number];

    const timeframe = (req.query.timeframe as string) || '7d';
    if (!VALID_TIMEFRAMES.includes(timeframe as Timeframe)) {
      res.status(400).json({ success: false, error: `Invalid timeframe. Must be one of: ${VALID_TIMEFRAMES.join(', ')}` });
      return;
    }

    const intervalMap: Record<Timeframe, string | null> = {
      '7d': "7 days",
      '30d': "30 days",
      'all': null,
    };

    const interval = intervalMap[timeframe as Timeframe];

    try {
      const data = await cache.getOrSet(`stats:volume_chart_${timeframe}`, 60_000, async () => {
        const whereClause = interval ? `WHERE timestamp >= now() - interval '${interval}'` : '';
        const result = await pool.query(`
          SELECT
            date_trunc('day', timestamp) AS day,
            COALESCE(SUM(volume_usd), 0) AS volume
          FROM swaps
          ${whereClause}
          GROUP BY day
          ORDER BY day ASC
        `);

        return result.rows.map((r: any) => ({
          date: r.day.toISOString().slice(0, 10),
          volume: parseFloat(r.volume),
        }));
      });

      res.json({ success: true, data });
    } catch (error) {
      console.error('Error fetching volume chart:', error);
      res.status(500).json({ success: false, error: 'Failed to fetch volume chart' });
    }
  }

  static async getFeesChart(req: Request, res: Response): Promise<void> {
    const VALID_TIMEFRAMES = ['7d', '30d', 'all'] as const;
    type Timeframe = typeof VALID_TIMEFRAMES[number];

    const timeframe = (req.query.timeframe as string) || '7d';
    if (!VALID_TIMEFRAMES.includes(timeframe as Timeframe)) {
      res.status(400).json({ success: false, error: `Invalid timeframe. Must be one of: ${VALID_TIMEFRAMES.join(', ')}` });
      return;
    }

    const intervalMap: Record<Timeframe, string | null> = {
      '7d': "7 days",
      '30d': "30 days",
      'all': null,
    };

    const interval = intervalMap[timeframe as Timeframe];

    try {
      const data = await cache.getOrSet(`stats:fees_chart_${timeframe}`, 60_000, async () => {
        const whereClause = interval ? `WHERE timestamp >= now() - interval '${interval}'` : '';
        const result = await pool.query(`
          SELECT
            date_trunc('day', timestamp) AS day,
            COALESCE(SUM(lp_fee_usd), 0) AS lp_fees,
            COALESCE(SUM(protocol_fee_usd), 0) AS protocol_fees,
            COALESCE(SUM(COALESCE(lp_fee_usd, 0) + COALESCE(protocol_fee_usd, 0)), 0) AS total_fees
          FROM swaps
          ${whereClause}
          GROUP BY day
          ORDER BY day ASC
        `);

        return result.rows.map((r: any) => ({
          date: r.day.toISOString().slice(0, 10),
          totalFees: parseFloat(r.total_fees),
          protocolFees: parseFloat(r.protocol_fees),
          lpFees: parseFloat(r.lp_fees),
        }));
      });

      res.json({ success: true, data });
    } catch (error) {
      console.error('Error fetching fees chart:', error);
      res.status(500).json({ success: false, error: 'Failed to fetch fees chart' });
    }
  }

  private static async computeVolume(): Promise<{ totalVolume: number; volume24h: number }> {
    return cache.getOrSet('stats:volume', 15_000, async () => {
      const now = Math.floor(Date.now() / 1000);
      const oneDayAgo = now - 24 * 60 * 60;

      const result = await pool.query(`
        SELECT
          COALESCE(SUM(volume_usd), 0) AS total_volume,
          COALESCE(SUM(CASE WHEN timestamp > to_timestamp($1) THEN volume_usd ELSE 0 END), 0) AS volume_24h
        FROM swaps
      `, [oneDayAgo]);

      return {
        totalVolume: parseFloat(result.rows[0].total_volume),
        volume24h: parseFloat(result.rows[0].volume_24h),
      };
    });
  }
}
