import { Request, Response } from 'express';
import { PoolController } from './poolController';
import { fetchTokenPrices } from '../services/jupiterPriceService';

export class StatsController {
  static async getStats(_req: Request, res: Response): Promise<void> {
    try {
      const allPools = await PoolController.fetchAllPools(false);

      const uniqueMints = new Set<string>();
      for (const p of allPools) {
        if (p.token0.address) uniqueMints.add(p.token0.address);
        if (p.token1.address) uniqueMints.add(p.token1.address);
      }

      const prices = await fetchTokenPrices(Array.from(uniqueMints));

      let totalTvl = 0;
      for (const p of allPools) {
        const reserve0 = parseFloat(p.reserves.token0);
        const reserve1 = parseFloat(p.reserves.token1);
        const price0 = prices.get(p.token0.address)?.price;
        const price1 = prices.get(p.token1.address)?.price;

        if (price0 && price1) {
          totalTvl += reserve0 * price0 + reserve1 * price1;
        } else if (price0) {
          totalTvl += reserve0 * price0 * 2;
        } else if (price1) {
          totalTvl += reserve1 * price1 * 2;
        }
      }

      res.json({
        success: true,
        data: {
          tvl: totalTvl,
          pool_count: allPools.length,
        },
      });
    } catch (error) {
      console.error('Error fetching stats:', error);
      res.status(500).json({ success: false, error: 'Failed to fetch stats' });
    }
  }
}
