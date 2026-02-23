import { Router } from 'express';
import { SwapController } from '../controllers/swapController';

const router = Router();

// Swaps endpoint - requires pair address
router.get('/:pairAddress', SwapController.getSwaps);

// Dynamic swap volume endpoint - accepts pair address and optional hours parameter
router.get('/volume/:pairAddress/:hours', SwapController.getSwapVolume);
router.get('/volume/:pairAddress', SwapController.getSwapVolume); // Default to 24 hours

// Dynamic chart prices endpoint - accepts pair address and optional hours parameter
router.get('/chart-prices/:pairAddress/:hours', SwapController.getChartPrices);
router.get('/chart-prices/:pairAddress', SwapController.getChartPrices); // Default to 24 hours

// Dynamic fee paid endpoint - accepts pair address and optional hours parameter
router.get('/fee-paid/:pairAddress/:hours', SwapController.getFeePaid);
router.get('/fee-paid/:pairAddress', SwapController.getFeePaid); // Default to 24 hours

export default router;
