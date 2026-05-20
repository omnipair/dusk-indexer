import { Request, Response } from 'express';
import pool from '../config/database';
import { cache } from '../utils/cache';
import {
  getMarketValueBaselines,
  MarketValueBaselineVisibility,
  normalizeMarketValueBaselineRange,
} from '../services/marketValueBaselineService';

export class MarketValueBaselineController {
  static async getValueBaselines(req: Request, res: Response): Promise<void> {
    try {
      const visibility = normalizeVisibility(req.query.visibility as string | undefined);
      const normalizedRange = normalizeMarketValueBaselineRange(req.query.range as string | undefined);
      const cacheKey = `market_value_baselines:${normalizedRange.range}:${visibility}`;

      const data = await cache.getOrSet(cacheKey, 30_000, () =>
        getMarketValueBaselines(pool, {
          range: normalizedRange.range,
          visibility,
        })
      );

      res.json({
        success: true,
        data,
      });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Unsupported range')) {
        res.status(400).json({ success: false, error: error.message });
        return;
      }

      console.error('Error fetching market value baselines:', error);
      res.status(500).json({ success: false, error: 'Failed to fetch market value baselines' });
    }
  }
}

function normalizeVisibility(visibility?: string): MarketValueBaselineVisibility {
  return visibility === 'all' ? 'all' : 'visible';
}
