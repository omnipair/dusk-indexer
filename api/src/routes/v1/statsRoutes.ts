import { Router } from 'express';
import { StatsController } from '../../controllers/statsController';

const router = Router();

router.get('/', StatsController.getStats);

export default router;
