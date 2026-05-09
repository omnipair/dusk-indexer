import { Request, Response } from 'express';
import pool from '../config/database';
import { ApiResponse } from '../types';
import { cache } from '../utils/cache';
import { isValidAddress } from './helpers/controllerBase';
import { getUserPortfolioSnapshots } from '../services/portfolioSnapshotService';

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
}
