import { BorshCoder } from '@coral-xyz/anchor';
import type { Dusk, LeveragePosition } from '@omnipair/dusk-sdk';
import { captureLiveMarketSimulation, duskRawIdl } from './duskMarketSimulation';
import { assertPortfolioPreviewState, indexedPortfolioDebt, nativeFields } from './duskPortfolioMath';
import { priceMarketBindings } from './duskPriceMath';
import { unsigned } from './duskYieldAccounting';
import type { DuskDeploymentEnvelope } from './duskDeploymentService';

const NAD = 1_000_000_000n, U64 = (1n << 64n) - 1n, U128 = (1n << 128n) - 1n;
const checked = (n: bigint) => unsigned(n, U128);

/** Display unrealized PnL at the symmetric risk EMA. This is neither a close
 * receipt nor proof of liquidation eligibility (which also depends on depth).
 * Match the program's normalization and aggregate debt-share burn rounding. */
export function oraclePositionValue(input: {
  collateralRaw: string; marginRaw: string; debtShares: string;
  aggregateShares: string; borrowIndexNad: string; oraclePriceNad: string;
  collateralDecimals: number; debtDecimals: number;
}) {
  const { collateralDecimals: cd, debtDecimals: dd } = input;
  if (![cd, dd].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 18))
    throw new Error('Invalid oracle valuation decimals');
  const collateral = unsigned(input.collateralRaw, U64), margin = unsigned(input.marginRaw, U64);
  const shares = unsigned(input.debtShares), aggregate = unsigned(input.aggregateShares);
  const oracle = unsigned(input.oraclePriceNad, U64);
  if (!oracle || !shares || shares > aggregate) throw new Error('Invalid oracle valuation state');
  const debt = indexedPortfolioDebt(aggregate, input.borrowIndexNad)
    - indexedPortfolioDebt(aggregate - shares, input.borrowIndexNad);
  const normalized = checked(collateral * NAD) / (10n ** BigInt(cd));
  const valueNad = checked(normalized * oracle) / NAD;
  const value = checked(valueNad * (10n ** BigInt(dd))) / NAD;
  const equity = value - debt;
  return { collateralValueRaw: value.toString(), debtRaw: debt.toString(),
    equityRaw: equity.toString(), pnlRaw: (equity - margin).toString(),
    underwater: equity <= 0n };
}

/** One clock-evaluated market preview for up to twenty positions, never one
 * close simulation per row. Position bytes are captured at that same bank. */
export async function captureOracleValuations(
  dusk: Dusk,
  rows: { address: string; data: string }[],
  deployment: DuskDeploymentEnvelope,
  signal?: AbortSignal,
  capture = captureLiveMarketSimulation,
) {
  const coder = new BorshCoder(duskRawIdl());
  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    const position = dusk.program.coder.accounts.decode<LeveragePosition>('leveragePosition', Buffer.from(row.data, 'base64'));
    const market = position.market.toBase58();
    groups.set(market, [...(groups.get(market) ?? []), row]);
  }
  const result = [];
  // Bound fanout and packet size. The wallet's final inventory read rejects
  // any position mutation between different market observations.
  for (const [market, positions] of groups) {
    for (let start = 0; start < positions.length; start += 20) {
      signal?.throwIfAborted();
      const batch = positions.slice(start, start + 20);
      const snapshot = await capture(market, deployment.sourceSlot, batch.map(p => p.address));
      if (snapshot.deploymentIdentitySha256 !== deployment.deploymentIdentitySha256)
        throw new Error('Oracle valuation deployment changed');
      for (const row of batch) {
        const captured = snapshot.accounts.find(a => a.address === row.address)?.account;
        if (!captured || captured.owner !== deployment.programId || captured.executable || captured.data !== row.data)
          throw new Error('Oracle valuation position changed during capture');
      }
      if (!snapshot.preview || snapshot.basis !== 'simulation-post-state') {
        result.push(...batch.map(row => ({ address: row.address, market, sourceSlot: snapshot.slot,
          status: 'unavailable' as const, reason: 'oracle-unavailable' as const })));
        continue;
      }
      const decoded = nativeFields(coder.accounts.decode('Market', Buffer.from(snapshot.marketAccount.data, 'base64')));
      const preview = nativeFields(coder.types.decode('MarketPreview', Buffer.from(snapshot.preview, 'base64')));
      const binding = priceMarketBindings(deployment.programId, market, decoded);
      assertPortfolioPreviewState(decoded, preview);
      const debtState = nativeFields(decoded.debt);
      for (const row of batch) {
        const p = dusk.program.coder.accounts.decode<LeveragePosition>('leveragePosition', Buffer.from(row.data, 'base64'));
        if (![0, 1].includes(p.debtAsset)) throw new Error('Invalid oracle valuation asset');
        const debtIsQuote = p.debtAsset === 1;
        const collateral = nativeFields(preview[debtIsQuote ? 'base' : 'quote']);
        const debt = nativeFields(preview[debtIsQuote ? 'quote' : 'base']);
        const oraclePriceNad = unsigned(collateral.price_ema_nad, U64).toString();
        if (oraclePriceNad === '0') {
          result.push({ address: row.address, market, sourceSlot: snapshot.slot,
            status: 'unavailable' as const, reason: 'oracle-unavailable' as const });
          continue;
        }
        const collateralDecimals = debtIsQuote ? binding.baseDecimals : binding.quoteDecimals;
        const debtDecimals = debtIsQuote ? binding.quoteDecimals : binding.baseDecimals;
        const value = oraclePositionValue({ collateralRaw: p.collateralAmount.toString(), marginRaw: p.marginAmount.toString(),
          debtShares: p.debtShares.toString(), aggregateShares: String(debtState[debtIsQuote ? 'isolated_quote_shares' : 'isolated_base_shares']),
          borrowIndexNad: String(debt.borrow_index_nad), oraclePriceNad, collateralDecimals, debtDecimals });
        result.push({ address: row.address, market, sourceSlot: snapshot.slot, status: 'available' as const,
          basis: 'symmetric-risk-ema.v1' as const, oraclePriceNad, collateralDecimals, debtDecimals, ...value });
      }
    }
  }
  signal?.throwIfAborted();
  return result;
}
