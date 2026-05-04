import path from 'path';
import { Router, Request, Response } from 'express';
import { CmcApiController } from '../../controllers/cmcApiController';

const router = Router();

router.get('/docs', (_req: Request, res: Response) => {
  res.type('html');
  res.sendFile(path.join(__dirname, '../../../public/cmc-api-docs.html'));
});

/** CoinMarketCap-style market data (unified asset ids, summary, ticker, trades). */
router.get('/factory', CmcApiController.getFactory);
router.get('/summary', CmcApiController.getSummary);
router.get('/assets', CmcApiController.getAssets);
router.get('/ticker', CmcApiController.getTicker);
router.get('/trades/:market_pair', CmcApiController.getTrades);

export default router;
