import { HLP_RATE_WINDOW_MS, trailingSrlpRate } from './duskHlpRates';

type TrancheProjection = {
  juniorMint: string;
  seniorReserveShares: string;
  juniorReserveShares: string;
  policy?: { juniorIncomeShareBps: number | null } | null;
  rates: unknown;
};

const BPS = 10_000n;

/** The governed junior share of every LP swap fee and interest credit, or
 * `null` when the market projection carries no share the program splits by. */
function juniorIncomeShareBps(tranches: TrancheProjection): bigint | null {
  const bps = tranches.policy?.juniorIncomeShareBps;
  return typeof bps === 'number' && Number.isInteger(bps) && bps >= 0 && bps < 10_000 ? BigInt(bps) : null;
}

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
 * with a second set of growth indexes. The program gives junior the market's
 * governed income share of every LP swap fee and interest credit and grows the
 * srLP indexes with the senior rest, so the recorded market rate is the senior
 * rate. Junior earns share / (1 - share) times senior's income over its own
 * live capital, so its display estimate scales by both ratios. */
export async function withTrancheRates(
  payload: Record<string, unknown>,
  deploymentIdentitySha256: string,
  read: typeof trailingSrlpRate = trailingSrlpRate,
): Promise<Record<string, unknown>> {
  const tranches = payload.tranches as TrancheProjection | null | undefined;
  if (!tranches) return payload;
  try {
    const rates = await read(deploymentIdentitySha256, {
      market: String(payload.marketAddress),
      srlpMint: String(payload.srlpMint),
      baseMint: String(payload.baseMint),
      quoteMint: String(payload.quoteMint),
      baseDecimals: Number(payload.baseDecimals),
      quoteDecimals: Number(payload.quoteDecimals),
    });
    const seniorShares = BigInt(tranches.seniorReserveShares);
    const juniorShares = BigInt(tranches.juniorReserveShares);
    const share = juniorIncomeShareBps(tranches);
    const numerator = share === null ? 0n : share * seniorShares;
    const denominator = share === null ? 0n : (BPS - share) * juniorShares;
    const juniorSwap = scale(rates.swapRatePct, numerator, denominator);
    const juniorInterest = scale(rates.interestRatePct, numerator, denominator);
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
            juniorShares === 0n || share === null
              ? null
              : {
                  growth: rates.growth,
                  estimate: 'governed-income-share-over-live-capital',
                  incomeShareBps: Number(share),
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
