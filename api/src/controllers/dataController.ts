import { Request, Response } from 'express';
import { SwapController } from './swapController';
import { PoolController } from './poolController';
import { PositionController } from './positionController';
import { UserController } from './userController';

/**
 * Backward-compatible facade that delegates to the split controllers.
 * New code should import from the specific controllers directly.
 */
export class DataController {
  // Swaps
  static getSwaps = (req: Request, res: Response) => SwapController.getSwaps(req, res);
  static getSwapVolume = (req: Request, res: Response) => SwapController.getSwapVolume(req, res);
  static getChartPrices = (req: Request, res: Response) => SwapController.getChartPrices(req, res);
  static getFeePaid = (req: Request, res: Response) => SwapController.getFeePaid(req, res);
  static getAPR = (req: Request, res: Response) => SwapController.getAPR(req, res);

  // Pools
  static getPoolInfo = (req: Request, res: Response) => PoolController.getPoolInfo(req, res);
  static getPoolOgCard = (req: Request, res: Response) => PoolController.getPoolOgCard(req, res);
  static getPools = (req: Request, res: Response) => PoolController.getPools(req, res);
  static getPoolsByTokens = (req: Request, res: Response) => PoolController.getPoolsByTokens(req, res);
  static getTokensByToken = (req: Request, res: Response) => PoolController.getTokensByToken(req, res);
  static getTvl = (req: Request, res: Response) => PoolController.getTvl(req, res);

  // Positions
  static getAllPositions = (req: Request, res: Response) => PositionController.getAllPositions(req, res);
  static getAllLiquidityPositions = (req: Request, res: Response) => PositionController.getAllLiquidityPositions(req, res);

  // Users
  static getUserHistory = (req: Request, res: Response) => UserController.getUserHistory(req, res);
  static getUserLendingHistory = (req: Request, res: Response) => UserController.getUserLendingHistory(req, res);
}

export { SwapController } from './swapController';
export { PoolController } from './poolController';
export { PositionController } from './positionController';
export { UserController } from './userController';
