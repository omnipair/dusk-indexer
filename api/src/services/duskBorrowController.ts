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
