import { failureReason, isFatalPortfolioError } from './duskPortfolioWorker';
import { PORTFOLIO_PRICE_REPAIR_INTERVAL_MS, repairPortfolioPriceHistory } from './duskPortfolioPriceRepair';

/** A bounded repair follows live refresh at most once per five minutes. The
 * existing idle timer supplies wakes even if there are no transactions. */
export function portfolioPriceRepairWake(options: {
  now?: () => number; repair?: typeof repairPortfolioPriceHistory;
} = {}) {
  const now = options.now ?? Date.now;
  let next = 0;
  return async () => {
    if (now()<next) return;
    next = now()+PORTFOLIO_PRICE_REPAIR_INTERVAL_MS;
    try {
      const result = await (options.repair ?? repairPortfolioPriceHistory)();
      if (result.examinedCaptures) console.log('Dusk historical portfolio price repair',result);
    } catch (error) {
      if (isFatalPortfolioError(error)) throw error;
      console.warn('Dusk historical price repair deferred; retrying next interval',{ reason: failureReason(error) });
    }
  };
}
