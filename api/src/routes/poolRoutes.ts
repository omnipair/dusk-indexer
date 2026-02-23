import { Router } from 'express';
import { PoolController } from '../controllers/poolController';
import { SwapController } from '../controllers/swapController';

const router = Router();

// Pool information endpoint - requires pair address
router.get('/info/:pairAddress', PoolController.getPoolInfo);

// APR endpoint - requires pair address
router.get('/apr/:pairAddress', SwapController.getAPR);

// All pools endpoint - returns all pools with pagination
router.get('/', PoolController.getPools);

// Paired tokens endpoint - returns all tokens paired with a given token
router.get('/paired-tokens/:token', PoolController.getTokensByToken);

// Pools by tokens endpoint - returns all pools matching two tokens
router.get('/:token0/:token1', PoolController.getPoolsByTokens);

export default router;
