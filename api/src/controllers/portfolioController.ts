import { Request, Response } from 'express';
import pool from '../config/database';
import { ApiResponse } from '../types';
import { cache } from '../utils/cache';
import { isValidAddress } from './helpers/controllerBase';
import { getUserPortfolioSnapshots } from '../services/portfolioSnapshotService';
import { getUserLpEarningsForRange } from '../services/lpPositionMetricsService';

export class PortfolioController {
  static async getUserPortfolioSnapshots(req: Request, res: Response): Promise<void> {
    try {
      const userAddress = req.params.userAddress;
      const range = req.query.range || '30D';

      if (!userAddress || !isValidAddress(userAddress)) {
        res.status(400).json({ success: false, error: 'Invalid user address format' });
        return;
      }

      const cacheKey = `portfolio_snapshots:${userAddress}:${String(range).toUpperCase()}`;
      const data = await cache.getOrSet(cacheKey, 30 * 1000, () =>
        getUserPortfolioSnapshots(pool, userAddress, range)
      );

      res.json({ success: true, data });
    } catch (error) {
      console.error('Error fetching portfolio snapshots:', error);
      const response: ApiResponse = {
        success: false,
        error: 'Failed to fetch portfolio snapshots',
      };
      res.status(500).json(response);
    }
  }

  static async getUserLpEarnings(req: Request, res: Response): Promise<void> {
    try {
      const userAddress = req.params.userAddress;
      const range = req.query.range || '30D';
      const poolAddress = typeof req.query.poolAddress === 'string' ? req.query.poolAddress : undefined;

      if (!userAddress || !isValidAddress(userAddress)) {
        res.status(400).json({ success: false, error: 'Invalid user address format' });
        return;
      }

      if (poolAddress && !isValidAddress(poolAddress)) {
        res.status(400).json({ success: false, error: 'Invalid pool address format' });
        return;
      }

      const cacheKey = `portfolio_lp_earnings:${userAddress}:${String(range).toUpperCase()}:${poolAddress ?? 'all'}`;
      const data = await cache.getOrSet(cacheKey, 30 * 1000, () =>
        getUserLpEarningsForRange(pool, userAddress, { range, poolAddress })
      );

      res.json({ success: true, data });
    } catch (error) {
      console.error('Error fetching LP earnings:', error);
      const response: ApiResponse = {
        success: false,
        error: 'Failed to fetch LP earnings',
      };
      res.status(500).json(response);
    }
  }
}
