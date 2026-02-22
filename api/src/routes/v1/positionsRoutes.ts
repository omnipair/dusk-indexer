import { Router, Request, Response } from 'express';
import { PositionController } from '../../controllers/positionController';

const router = Router();

router.get('/', PositionController.getAllPositions);

router.get('/liquidity', PositionController.getAllLiquidityPositions);

router.get('/:positionId', async (req: Request, res: Response) => {
  res.status(501).json({
    success: false,
    error: 'Single position endpoint not yet implemented. Use GET /api/v1/positions with filters to find positions.'
  });
});

export default router;
