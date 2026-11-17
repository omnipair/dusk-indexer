import { riskCoverageSignalNad, type Market } from '@omnipair/dusk-sdk';

interface InterestLedger {
  credited: { toString(): string }; protocolUnpaid: { toString(): string };
  fundingRecognized: { toString(): string }; deficit: { toString(): string };
}

/** The program's `curve_reserve`: live reserve plus recognized hLP funding
 * interest and the recorded deficit, less credited interest and the
 * protocol's unpaid share, floored at zero. */
export function curveReserve(side: { reserves: { liveReserve: { toString(): string } }; fees: { ledger?: InterestLedger } }): bigint {
  const ledger = side.fees.ledger;
  if (!ledger) throw new Error('Missing interest ledger');
  const n = (value: { toString(): string }) => BigInt(value.toString());
  const backing = n(side.reserves.liveReserve)+n(ledger.fundingRecognized)+n(ledger.deficit);
  const owed = n(ledger.credited)+n(ledger.protocolUnpaid);
  return backing>owed ? backing-owed : 0n;
}

/** Same-bank inputs for an illustrative new borrow, in quote-denominated NAD.
 * Mirrors covered_debt/funded_reserve_value/tranche_coverage_signals: junior
 * is backed by LP principal, each asset's `curve_reserve`. Interest credited
 * to holders and the protocol's unpaid share belong to them, not to junior. */
export function projectBorrowController(input: unknown, sourceSlot: number) {
  // The API's raw IDL coder retains snake_case; SDK callers use camelCase.
  // Preserve BN/PublicKey instances while normalizing only decoded records.
  const camel = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(camel);
    if (value && Object.getPrototypeOf(value) === Object.prototype) return Object.fromEntries(
      Object.entries(value).map(([key,item]) => [key.replace(/_([a-z])/g,(_,letter: string) => letter.toUpperCase()),camel(item)]));
    return value;
  };
  const market = camel(input) as Market & Record<'baseSide' | 'quoteSide', { fees: { ledger: InterestLedger } }>;
  const nad = 1_000_000_000n;
  const n = (value: { toString(): string }) => BigInt(value.toString());
  const mark = n(market.amm.priceEmaNad) || n(market.risk.basePriceEmaNad) || n(market.amm.launchReferencePriceNad);
  if (mark <= 0n) return null;
  const sides = [market.baseSide,market.quoteSide];
  const normalize = (raw: bigint,index: number) => raw * nad / (10n ** BigInt(sides[index].assetDecimals));
  const value = (raw: bigint,index: number) => index === 0 ? normalize(raw,index)*mark/nad : normalize(raw,index);
  const debt = market.debt;
  const inputs = sides.map((side,index) => {
    const borrowIndex = n(index === 0 ? debt.baseBorrowIndexNad : debt.quoteBorrowIndexNad);
    const fixed = n(index === 0 ? debt.fixedBaseShares : debt.fixedQuoteShares)*borrowIndex/nad;
    const isolated = n(index === 0 ? debt.isolatedBaseShares : debt.isolatedQuoteShares)*borrowIndex/nad;
    const hlp = n(index === 0 ? market.quoteHlpVault.debtShares : market.baseHlpVault.debtShares)*borrowIndex/nad;
    return { debt: fixed+isolated+hlp,cash: n(side.reserves.cashReserve),funded: curveReserve(side) };
  });
  const totalDebt = inputs.reduce((sum,side,index) => sum+value(side.debt,index),0n);
  const funded = inputs.reduce((sum,side,index) => sum+value(side.funded,index),0n);
  const juniorShares = n(market.tranches.juniorReserveShares),supply = n(market.baseSide.shares.srlpSupply);
  if (juniorShares>supply) throw new Error('Junior backing exceeds reserve shares');
  const junior = supply === 0n ? 0n : funded*juniorShares/supply;
  const side = (index: number) => {
    const input = inputs[index];
    return { coveredDebtRaw: input.debt.toString(),cashRaw: input.cash.toString(),
      coveredDebtValueNad: value(input.debt,index).toString(),cashValueNad: value(input.cash,index).toString(),
      signalNad: input.debt === 0n ? null : juniorShares === 0n ? '0' : totalDebt === 0n ? null : riskCoverageSignalNad(junior,totalDebt,input.debt,input.cash)?.toString() ?? null };
  };
  return { schemaVersion: 'dusk-borrow-controller.v1',basis: 'funded-junior-covered-debt.v1',sourceSlot,
    fundedJuniorValueNad: junior.toString(),totalCoveredDebtValueNad: totalDebt.toString(),base: side(0),quote: side(1) };
}

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
  unallocatedSwapFeeLiability: unknown; swapFeeGrowthRemainderScaled: unknown;
  junior?: { swapGrowthQ64: unknown; interestGrowthQ64: unknown };
}
interface GrowthSide {
  assetMint: { equals(other: unknown): boolean }; hlpMint: { equals(other: unknown): boolean };
  fees: GrowthFees; shares: { srlpSupply: unknown }; reserves?: { cashReserve: unknown };
}
/** The camelCase layout-19 market and yield account the pinned SDK decodes. */
export interface LiveYieldMarket {
  srlpMint: { equals(other: unknown): boolean };
  juniorMint?: { equals(other: unknown): boolean };
  baseSide: GrowthSide; quoteSide: GrowthSide;
  baseHlpVault: Record<string, unknown>; quoteHlpVault: Record<string, unknown>;
}
export interface LiveYieldAccount {
  assetMint: unknown; lpMint: unknown; tokenKind: number;
  swapFeeCheckpointQ64: unknown; interestCheckpointQ64: unknown;
  swapFeeRemainderQ64: unknown; interestRemainderQ64: unknown;
  accruedSwapFeeAmount: unknown; accruedInterestAmount: unknown;
  escrowBalance?: unknown;
}

/** An index after crediting growth that is recorded but not yet distributed. */
function publishedIndex(index: unknown, amount: unknown, supply: unknown, carry: unknown): bigint {
  const current = unsigned(index), shares = unsigned(supply, U64_MAX);
  if (shares === 0n) return current;
  return unsigned(current + (unsigned(amount, U64_MAX) * Q64 + unsigned(carry, U64_MAX)) / shares);
}

/** What a holder is owed now. The market must already be the preview's
 * updated post-state, whose accrual has credited interest to every lane:
 * ordinary srLP through `fees.interestGrowthIndexQ64`, junior through its
 * tranche index, an hLP vault through its own per-asset interest index (held
 * as unallocated only while the vault has no supply). Interest a frozen vault
 * holds for its creditors (`held*Interest`) is the vault's and never enters
 * that index unless the vault unfreezes. Claimable interest is
 * the holder's checkpointed amount plus its balance times the index change.
 * Swap fees are carried forward and, for hLP, the vault's srLP swap-fee
 * entitlement is checkpointed into hLP growth first, as the program's lazy
 * update does. A retired hLP or junior cohort reads its frozen indexes. */
export function projectLiveYield(market: LiveYieldMarket, account: LiveYieldAccount, balance: bigint, retiredVault?: Record<string, unknown>) {
  const side = market.baseSide.assetMint.equals(account.assetMint) ? 'base'
    : market.quoteSide.assetMint.equals(account.assetMint) ? 'quote' : null;
  if (!side) throw new Error('Yield asset is outside its market');
  const state = side === 'base' ? market.baseSide : market.quoteSide;
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
    interest = retiredVault ? unsigned(retiredVault[`${side}InterestGrowthIndexQ64`]) : unsigned(state.fees.interestGrowthIndexQ64);
  }
  if (account.tokenKind === 0) {
    if (retiredVault) throw new Error('Retired yield requires an hLP receipt');
    if (!market.srlpMint.equals(account.lpMint)) throw new Error('Invalid srLP mint');
  } else if (account.tokenKind === 1 && !retiredVault) {
    const vault = market.baseSide.hlpMint.equals(account.lpMint) ? market.baseHlpVault
      : market.quoteSide.hlpMint.equals(account.lpMint) ? market.quoteHlpVault : null;
    if (!vault) throw new Error('Invalid hLP mint');
    const prefix = side === 'base' ? 'Base' : 'Quote';
    const swapCredit = BigInt(settleRecordedGrowth({ balance: vault.srlpShares, index: swap,
      checkpoint: vault[`${side}SwapFeeCheckpointQ64`], remainder: vault[`${side}SwapFeeRemainderQ64`], accrued: 0 }).amount);
    swap = publishedIndex(vault[`${side}SwapFeeGrowthIndexQ64`], unsigned(vault[`unallocated${prefix}SwapFeeAmount`], U64_MAX) + swapCredit,
      vault.hlpSupply, vault[`${side}SwapFeeGrowthRemainderScaled`]);
    interest = publishedIndex(vault[`${side}InterestGrowthIndexQ64`], vault[`unallocated${prefix}InterestAmount`],
      vault.hlpSupply, vault[`${side}InterestGrowthRemainderScaled`]);
  } else if (account.tokenKind !== 1 && account.tokenKind !== 2) throw new Error('Invalid LP token kind');
  const swapFeeAmount = BigInt(settleRecordedGrowth({ balance, index: swap, checkpoint: account.swapFeeCheckpointQ64,
    remainder: account.swapFeeRemainderQ64, accrued: account.accruedSwapFeeAmount }).amount);
  const interestAmount = BigInt(settleRecordedGrowth({ balance, index: interest, checkpoint: account.interestCheckpointQ64,
    remainder: account.interestRemainderQ64, accrued: account.accruedInterestAmount }).amount);
  return { side: side as 'base' | 'quote', swapFeeAmount, interestAmount, totalAmount: unsigned(swapFeeAmount + interestAmount, U64_MAX) };
}

/** The interest a harvest pays now: credited interest is paid from the asset's
 * reserve cash as cash allows, and the rest stays claimable. Read the cash
 * from the same updated bank as the claim. */
export function payableInterest(market: Pick<LiveYieldMarket, 'baseSide' | 'quoteSide'>, side: 'base' | 'quote', interestAmount: bigint): bigint {
  const reserves = (side === 'base' ? market.baseSide : market.quoteSide).reserves;
  if (!reserves) throw new Error('Missing reserve cash for interest payment');
  const cash = unsigned(reserves.cashReserve, U64_MAX);
  return interestAmount < cash ? interestAmount : cash;
}
