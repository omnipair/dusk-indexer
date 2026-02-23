import { Router } from 'express';
import { StatsController } from '../../controllers/statsController';

const router = Router();

router.get('/', StatsController.getStats);
router.get('/volume-chart', StatsController.getVolumeChart);

export default router;
