import { Router } from 'express';
import { GeckoTerminalController } from '../../controllers/geckoTerminalController';

const router = Router();

/**
 * GeckoTerminal Integration API endpoints.
 *
 * Spec (v0.1):
 * https://docs.google.com/document/d/1ufjAJUa6rGO9PBGJGwfBMn-XMk9NE0ow3_iMYrS3drk
 */
router.get('/latest-block', GeckoTerminalController.getLatestBlock);
router.get('/asset', GeckoTerminalController.getAsset);
router.get('/pair', GeckoTerminalController.getPair);
router.get('/events', GeckoTerminalController.getEvents);

export default router;
