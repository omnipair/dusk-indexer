import { projectHolderIncome, type IncomeArchiveMap, type IncomeBookInput, type IncomeClaimInput, type IncomeEndInput } from "@omnipair/dusk-sdk";
const Q64 = 1n << 64n;
const U64_MAX = (1n << 64n) - 1n;
const U128_MAX = (1n << 128n) - 1n;

export function unsigned(value: unknown, max = U128_MAX): bigint {
  if (typeof value === 'number' && !Number.isSafeInteger(value))
    throw new Error('Native amount must not lose integer precision');
  const text = String(value);
  if (!/^\d+$/.test(text)) throw new Error('Invalid unsigned native amount');
  const result = BigInt(text);
  if (result > max) throw new Error('Native amount overflow');
  return result;
}

/** Committed growth only: deferred market/vault updates are not invented. */
export function settleRecordedGrowth(input: { balance: unknown; index: unknown; checkpoint: unknown; remainder: unknown; accrued: unknown }) {
  const balance = unsigned(input.balance, U64_MAX), index = unsigned(input.index);
  const checkpoint = unsigned(input.checkpoint), remainder = unsigned(input.remainder, U64_MAX);
  const accrued = unsigned(input.accrued, U64_MAX);
  if (index < checkpoint) throw new Error('Yield growth regressed behind its checkpoint');
  const scaled = balance * (index-checkpoint) + remainder;
  const amount = accrued + scaled / Q64;
  if (amount > U64_MAX) throw new Error('Yield amount overflow');
  return { amount: amount.toString(), remainder: (scaled % Q64).toString() };
}

interface GrowthFees {
  swapFeeGrowthIndexQ64: unknown; interestGrowthIndexQ64: unknown;
  unallocatedSwapFeeLiability: unknown; unallocatedInterestLiability: unknown;
  swapFeeGrowthRemainderScaled: unknown; interestGrowthRemainderScaled: unknown;
  junior?: { swapGrowthQ64: unknown; interestGrowthQ64: unknown };
}
interface GrowthSide { assetMint: { equals(other: unknown): boolean }; hlpMint: { equals(other: unknown): boolean }; fees: GrowthFees; shares: { srlpSupply: unknown } }
/** The camelCase market and yield account the pinned SDK decodes. */
export interface LiveYieldMarket {
  srlpMint: { equals(other: unknown): boolean };
  juniorMint?: { equals(other: unknown): boolean };
  baseSide: GrowthSide; quoteSide: GrowthSide;
  baseHlpVault: Record<string, unknown>; quoteHlpVault: Record<string, unknown>;
  income: { books: readonly IncomeBookInput[]; juniorEnd: readonly IncomeEndInput[] };
}
export interface LiveYieldAccount {
  assetMint: unknown; lpMint: unknown; tokenKind: number;
  swapFeeCheckpointQ64: unknown; interestCheckpointQ64: unknown;
  swapFeeRemainderQ64: unknown; interestRemainderQ64: unknown;
  accruedSwapFeeAmount: unknown; accruedInterestAmount: unknown;
  escrowBalance?: unknown;
  incomeInitialized: boolean; income: readonly IncomeClaimInput[];
}

/** An index after crediting growth that is recorded but not yet distributed. */
function publishedIndex(index: unknown, amount: unknown, supply: unknown, carry: unknown): bigint {
  const current = unsigned(index), shares = unsigned(supply, U64_MAX);
  if (shares === 0n) return current;
  return unsigned(current + (unsigned(amount, U64_MAX) * Q64 + unsigned(carry, U64_MAX)) / shares);
}

/** The amount Harvest would pay now: the market's undistributed growth is
 * carried forward and, for hLP, the vault's srLP entitlement is checkpointed
 * into hLP growth first, exactly as the program's lazy update does. The
 * market must already be the preview's updated post-state. */
export function projectLiveYield(market: LiveYieldMarket, account: LiveYieldAccount, balance: bigint, retiredVault?: Record<string, unknown>, income?: {ends?: readonly IncomeEndInput[]; archives?: IncomeArchiveMap; pendingHistory?: boolean}) {
  const side = market.baseSide.assetMint.equals(account.assetMint) ? 'base'
    : market.quoteSide.assetMint.equals(account.assetMint) ? 'quote' : null;
  if (!side) throw new Error('Yield asset is outside its market');
  const state = side === 'base' ? market.baseSide : market.quoteSide;
  const receivableIncome = income?.pendingHistory ? 0n : projectHolderIncome({holder:{tokenKind:account.tokenKind,incomeInitialized:account.incomeInitialized===true,escrowBalance:unsigned(account.escrowBalance??0,U64_MAX),income:account.income},books:market.income.books,asset:side==='base'?0:1,walletBalance:balance,ends:income?.ends??market.income.juniorEnd,archives:income?.archives});
  let swap: bigint;
  let interest: bigint;
  if (account.tokenKind === 2) {
    if (!retiredVault && !market.juniorMint?.equals(account.lpMint)) throw new Error('Invalid jrLP mint');
    const junior = retiredVault ?? state.fees.junior;
    if (!junior) throw new Error('Missing junior yield ledger');
    swap = unsigned(junior.swapGrowthQ64);
    interest = unsigned(junior.interestGrowthQ64);
    balance = unsigned(balance + unsigned(account.escrowBalance ?? 0,U64_MAX),U64_MAX);
  } else {
    swap = retiredVault ? unsigned(retiredVault[`${side}SwapFeeGrowthIndexQ64`]) : publishedIndex(state.fees.swapFeeGrowthIndexQ64, state.fees.unallocatedSwapFeeLiability,
      state.shares.srlpSupply, state.fees.swapFeeGrowthRemainderScaled);
    interest = retiredVault ? unsigned(retiredVault[`${side}InterestGrowthIndexQ64`]) : publishedIndex(state.fees.interestGrowthIndexQ64, state.fees.unallocatedInterestLiability,
      state.shares.srlpSupply, state.fees.interestGrowthRemainderScaled);
  }
  if (account.tokenKind === 0) {
    if (retiredVault) throw new Error('Retired yield requires an hLP receipt');
    if (!market.srlpMint.equals(account.lpMint)) throw new Error('Invalid srLP mint');
  } else if (account.tokenKind === 1 && !retiredVault) {
    const vault = market.baseSide.hlpMint.equals(account.lpMint) ? market.baseHlpVault
      : market.quoteSide.hlpMint.equals(account.lpMint) ? market.quoteHlpVault : null;
    if (!vault) throw new Error('Invalid hLP mint');
    const prefix = side === 'base' ? 'Base' : 'Quote';
    const credit = (index: bigint, name: 'SwapFee' | 'Interest') => BigInt(settleRecordedGrowth({ balance: vault.srlpShares,
      index, checkpoint: vault[`${side}${name}CheckpointQ64`], remainder: vault[`${side}${name}RemainderQ64`], accrued: 0 }).amount);
    const swapCredit = credit(swap, 'SwapFee'), interestCredit = credit(interest, 'Interest');
    swap = publishedIndex(vault[`${side}SwapFeeGrowthIndexQ64`], unsigned(vault[`unallocated${prefix}SwapFeeAmount`], U64_MAX) + swapCredit,
      vault.hlpSupply, vault[`${side}SwapFeeGrowthRemainderScaled`]);
    interest = publishedIndex(vault[`${side}InterestGrowthIndexQ64`], unsigned(vault[`unallocated${prefix}InterestAmount`], U64_MAX) + interestCredit,
      vault.hlpSupply, vault[`${side}InterestGrowthRemainderScaled`]);
  } else if (account.tokenKind !== 1 && account.tokenKind !== 2) throw new Error('Invalid LP token kind');
  const swapFeeAmount = BigInt(settleRecordedGrowth({ balance, index: swap, checkpoint: account.swapFeeCheckpointQ64,
    remainder: account.swapFeeRemainderQ64, accrued: account.accruedSwapFeeAmount }).amount);
  const interestAmount = unsigned(BigInt(settleRecordedGrowth({ balance, index: interest, checkpoint: account.interestCheckpointQ64,
    remainder: account.interestRemainderQ64, accrued: account.accruedInterestAmount }).amount)+receivableIncome,U64_MAX);
  return { side: side as 'base' | 'quote', swapFeeAmount, interestAmount, totalAmount: unsigned(swapFeeAmount + interestAmount, U64_MAX) };
}
