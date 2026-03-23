import { Router } from 'express';
import { StatsController } from '../../controllers/statsController';

const router = Router();

router.get('/', StatsController.getStats);
router.get('/volume-chart', StatsController.getVolumeChart);
router.get('/fees-chart', StatsController.getFeesChart);
router.get('/interest-chart', StatsController.getInterestChart);
router.get('/swap-count-chart', StatsController.getSwapCountChart);

export default router;
