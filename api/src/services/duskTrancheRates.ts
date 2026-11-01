import { HLP_RATE_WINDOW_MS, trailingYlpRate } from './duskHlpRates';

type TrancheProjection = {
  juniorMint: string;
  seniorReserveShares: string;
  juniorReserveShares: string;
  rates: unknown;
};

function add(left: string | null | undefined, right: string | null | undefined) {
  if (left == null || right == null) return null;
  const value = Number(left) + Number(right);
  if (!Number.isFinite(value)) return null;
  return value.toFixed(8).replace(/\.?0+$/, '') || '0';
}

function scale(value: string | null | undefined, numerator: bigint, denominator: bigint) {
  if (value == null || denominator === 0n) return null;
  const result = (Number(value) * Number(numerator)) / Number(denominator);
  if (!Number.isFinite(result)) return null;
  return result.toFixed(8).replace(/\.?0+$/, '') || '0';
}

/** The swap stream records pool income without enlarging every swap receipt
 * with a second set of growth indexes. The senior rate is the recorded market
 * rate; junior receives the same 50% income budget over its current smaller
 * capital base, so its display estimate scales by live senior/junior shares. */
export async function withTrancheRates(
  payload: Record<string, unknown>,
  deploymentIdentitySha256: string,
  read: typeof trailingYlpRate = trailingYlpRate,
): Promise<Record<string, unknown>> {
  const tranches = payload.tranches as TrancheProjection | null | undefined;
  if (!tranches) return payload;
  try {
    const rates = await read(deploymentIdentitySha256, {
      market: String(payload.marketAddress),
      ylpMint: String(payload.ylpMint),
      baseMint: String(payload.baseMint),
      quoteMint: String(payload.quoteMint),
      baseDecimals: Number(payload.baseDecimals),
      quoteDecimals: Number(payload.quoteDecimals),
    });
    const seniorShares = BigInt(tranches.seniorReserveShares);
    const juniorShares = BigInt(tranches.juniorReserveShares);
    const juniorSwap = scale(rates.swapRatePct, seniorShares, juniorShares);
    const juniorInterest = scale(rates.interestRatePct, seniorShares, juniorShares);
    return {
      ...payload,
      tranches: {
        ...tranches,
        rates: {
          schemaVersion: 'dusk-tranche-rates.v1',
          basis: 'recorded-income-live-capital.v1',
          annualization: 'simple-365-day',
          windowSeconds: HLP_RATE_WINDOW_MS / 1000,
          senior: {
            growth: rates.growth,
            swapRatePct: rates.swapRatePct,
            interestRatePct: rates.interestRatePct,
            totalRatePct: add(rates.swapRatePct, rates.interestRatePct),
          },
          junior:
            juniorShares === 0n
              ? null
              : {
                  growth: rates.growth,
                  estimate: 'fixed-50-50-income-over-live-capital',
                  swapRatePct: juniorSwap,
                  interestRatePct: juniorInterest,
                  totalRatePct: add(juniorSwap, juniorInterest),
                },
        },
      },
    };
  } catch (error) {
    console.warn('tranche rate read failed', error instanceof Error ? error.message : error);
    return payload;
  }
}
