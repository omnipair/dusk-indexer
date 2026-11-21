// Owner-selected hosted policy, 2026-11-21: no additional token inventory or
// socialized-loss ceilings. SOL fee/reserve limits remain in the keeper image.
// Supplying these settings does not activate execution; KeeperMode defaults to shadow.
export const U64_MAX = '18446744073709551615';

export function keeperExecutionEnvironment(profile: string): Record<string, string> {
  if (profile === 'sentinel') return {};
  const common = {
    KEEPER_MAX_SENDS_PER_PASS: '1',
    KEEPER_MINIMUM_LAMPORTS: '50000000',
    KEEPER_RISK_POLICY: '/app/config/risk-policy.json',
  };
  switch (profile) {
    case 'lending':
    case 'leverage':
      return { ...common,
        ...(profile === 'lending' ? { KEEPER_LENDING_MODE: 'both' } : {}),
        KEEPER_FLASH_SETTLEMENT: 'inventory',
        KEEPER_FLASH_MAX_REPAY: U64_MAX,
        KEEPER_FLASH_MAX_PAYMENT_DEBIT: U64_MAX,
        KEEPER_FLASH_MIN_COLLATERAL_CREDIT: '1',
        KEEPER_LIQUIDATION_MIN_PROFIT: '0',
        KEEPER_EMERGENCY_SLIPPAGE_BPS: '100',
        KEEPER_ORDER_MIN_BOUNTY_CREDIT: '0',
      };
    case 'hlp-recovery':
      return { ...common,
        KEEPER_HLP_MAX_SOCIALIZED_LOSS: U64_MAX,
        KEEPER_HLP_MAX_PAYMENT_DEBIT: U64_MAX,
        KEEPER_HLP_MIN_COLLATERAL_CREDIT: '1',
        KEEPER_HLP_MIN_BOUNTY_OUT: '0',
      };
    case 'auction-arbitrage':
      return { ...common,
        KEEPER_AUCTION_MAX_SOLD: U64_MAX,
        KEEPER_AUCTION_MAX_PAYMENT: U64_MAX,
        KEEPER_AUCTION_SLIPPAGE_BPS: '50',
      };
    case 'lifecycle': return common;
    default: throw new Error(`Unsupported keeper profile: ${profile}`);
  }
}
