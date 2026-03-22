import { Router } from 'express';
import { CoinGeckoController } from '../../controllers/coingeckoController';

const router = Router();

router.get('/tickers', CoinGeckoController.getTickers);

export default router;
