import { Router } from 'express';
import { PositionController } from '../controllers/positionController';

const router = Router();

// All positions endpoint - returns all borrow positions with pagination
router.get('/', PositionController.getAllPositions);

// All liquidity positions endpoint - returns all liquidity positions with pagination
router.get('/liquidity', PositionController.getAllLiquidityPositions);

export default router;
