import { Router } from 'express';
import { SwapController } from '../controllers/swapController';
import { UserController } from '../controllers/userController';

const router = Router();

// User swaps endpoint - returns all swaps for a specific user address
router.get('/:userAddress/swap-history', SwapController.getSwaps);

// User history endpoint - returns liquidity adjustment data for a specific user and pair
router.get('/:userAddress/history/:pair', UserController.getUserHistory);

// User lending history endpoint - returns all lending/borrowing activities for a specific user
router.get('/:userAddress/lending-history', UserController.getUserLendingHistory);

export default router;
