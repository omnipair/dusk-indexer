import { PublicKey } from '@solana/web3.js';
import { formatUsd, usdUnits } from './duskPortfolioMath';
import { multiplyPriceRatio } from './duskPriceMath';

export const ACTIVITY_EVENTS = [
  'SwapExecuted', 'LeveragePositionOpened', 'LeveragePositionUpdated',
  'LeveragePositionClosed', 'LeveragePositionLiquidated', 'MarketDebtUpdated',
  'FlashLiquidationSettled', 'EmergencyLiquidationSettled',
  'HlpClosed', 'HlpTerminalLiquidated',
] as const;
export type ActivityEventName = typeof ACTIVITY_EVENTS[number];
export type ActivityMetric = 'volume' | 'swapFees' | 'retainedFees' | 'compoundedFees' | 'reportedInterest' | 'creditVolume' | 'marginVolume';
export const ACTIVITY_METRICS: readonly ActivityMetric[] = ['volume','swapFees','retainedFees','compoundedFees','reportedInterest','creditVolume','marginVolume'];
export interface ActivityAmount {
  metric: ActivityMetric;
  amount: string;
  asset: { side: 0 | 1 } | { mint: string };
  /** A swap's curve output, before any output-side fee. It values the trade
   * instead of the input when it is a USD stablecoin and the input is not. */
  output?: { amount: string; asset: { side: 0 | 1 } };
}
const U64 = (1n << 64n) - 1n;
function fields(value: unknown): Record<string,unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid native activity payload');
  return value as Record<string,unknown>;
}
function address(value: unknown): string {
  if (typeof value !== 'string' || new PublicKey(value).toBase58() !== value) throw new Error('Invalid native activity address');
  return value;
}
function unsigned(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,19})$/.test(value) || BigInt(value)>U64)
    throw new Error('Invalid native activity u64');
  return BigInt(value);
}
function side(value: unknown): 0 | 1 {
  if (value !== '0' && value !== '1') throw new Error('Invalid native activity asset side');
  return value === '0' ? 0 : 1;
}

export type SwapVolumeBasis = 'embedded-leverage-receipts' | 'canonical-swap-events';

/** The reviewed IDL, never transaction arrival order, selects the swap source. */
export function swapVolumeBasis(idl: { types?: { name: string; type: { kind: string; fields?: { name: string }[] } }[] }): SwapVolumeBasis {
  return idl.types?.find((type) => type.name === 'SwapExecuted')?.type.fields?.some((field) => field.name === 'origin')
    ? 'canonical-swap-events' : 'embedded-leverage-receipts';
}
function signed(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(0|-?[1-9]\d{0,18})$/.test(value)
    || BigInt(value)<-(1n<<63n) || BigInt(value)>=(1n<<63n)) throw new Error('Invalid native activity i64');
  return BigInt(value);
}

/** Pinned event amounts. Payouts, referrals and fee auctions are not new fees. */
export function parseActivityEvent(eventName: string,payload: unknown,slot: string,basis: SwapVolumeBasis = 'embedded-leverage-receipts') {
  if (!(ACTIVITY_EVENTS as readonly string[]).includes(eventName)) throw new Error('Unsupported native activity event');
  const event = fields(payload),market = address(event.market),sourceSlot = unsigned(slot);
  const settlement = eventName === 'FlashLiquidationSettled' || eventName === 'EmergencyLiquidationSettled';
  const leverage = eventName.startsWith('LeveragePosition') || settlement && event.leverage === true;
  if ((leverage && !settlement) || eventName === 'MarketDebtUpdated') {
    const metadata = fields(event.metadata);
    if (address(metadata.market) !== market || unsigned(metadata.slot) !== sourceSlot)
      throw new Error('Native activity metadata differs from its containing event');
    address(metadata.signer);
  }
  let swap: Record<string,unknown> | null = null;
  if (eventName === 'SwapExecuted') swap = event;
  else if (leverage && !settlement && basis === 'embedded-leverage-receipts') {
    if (eventName === 'LeveragePositionUpdated' && event.swap === null) swap = null;
    else swap = fields(event.swap);
  }
  const amounts: ActivityAmount[] = [];
  if (swap) {
    const inputSide = side(swap.asset_in_side),feeSide = side(swap.fee_asset_side);
    const amountIn = unsigned(swap.amount_in),amountOut = unsigned(swap.amount_out);
    const grossOut = unsigned(swap.gross_amount_out),netInput = unsigned(swap.amount_in_after_fee);
    const base = unsigned(swap.base_fee),divergence = unsigned(swap.divergence_fee),volatility = unsigned(swap.volatility_fee);
    const retained = unsigned(swap.retained_fee),compounded = unsigned(swap.compounded_fee),total = base+divergence+volatility;
    if (amountIn === 0n || amountOut>grossOut || netInput>amountIn || total>U64
      || retained>divergence+volatility || compounded+retained>total)
      throw new Error('Inconsistent native swap amounts');
    // Output transfer taxes and leverage reserve-credit taxes are independent
    // of the protocol fee. Never infer fee lanes by subtracting input/output.
    if (leverage && unsigned(swap.claimable_fee_credit)>total-retained-compounded)
      throw new Error('Native swap fee credit exceeds its claimable debit');
    amounts.push(
      { metric: 'volume',amount: amountIn.toString(),asset: { side: inputSide },
        output: { amount: grossOut.toString(),asset: { side: inputSide === 0 ? 1 : 0 } } },
      { metric: 'swapFees',amount: total.toString(),asset: { side: feeSide } },
      { metric: 'retainedFees',amount: retained.toString(),asset: { side: feeSide } },
      { metric: 'compoundedFees',amount: compounded.toString(),asset: { side: feeSide } },
    );
  }
  if (eventName === 'MarketDebtUpdated') {
    const delta = signed(event.debt_delta);
    if (delta>0n) amounts.push({ metric: 'creditVolume',amount: delta.toString(),asset: { mint: address(event.debt_asset_mint) } });
  }
  // Exposure turnover is the collateral quantity opened/closed, including
  // collateral supplied without a swap. Pure margin deposits/withdrawals and
  // debt repayments change financing, not traded exposure.
  let exposure = 0n;
  if (eventName === 'LeveragePositionOpened') exposure = unsigned(event.collateral_amount);
  else if (eventName === 'LeveragePositionClosed' || eventName === 'LeveragePositionLiquidated') exposure = unsigned(event.collateral_sold);
  else if (settlement && event.leverage === true)
    exposure = eventName === 'FlashLiquidationSettled'
      ? unsigned(event.collateral_debit) : unsigned(fields(event.quote).collateral_debit);
  else if (eventName === 'LeveragePositionUpdated') {
    const delta = signed(event.collateral_delta);
    if (event.swap !== null || unsigned(event.borrowed_amount)>0n) exposure = delta<0n ? -delta : delta;
  }
  if (exposure>0n) {
    const asset = settlement
      ? { side: (side(event.debt_asset) === 0 ? 1 : 0) as 0 | 1 }
      : { mint: address(event.collateral_asset_mint) };
    amounts.push({ metric: 'marginVolume',amount: exposure.toString(),asset });
  }
  if (settlement) {
    const loss = eventName === 'FlashLiquidationSettled' ? fields(event.loss) : fields(fields(event.quote).loss);
    amounts.push({ metric: 'reportedInterest',amount: unsigned(loss.interest_paid).toString(),asset: { side: side(event.debt_asset) } });
  } else if (['MarketDebtUpdated','LeveragePositionClosed','LeveragePositionLiquidated'].includes(eventName)) {
    amounts.push({ metric: 'reportedInterest',amount: unsigned(event.interest_paid).toString(),asset: { mint: address(event.debt_asset_mint) } });
  } else if (eventName === 'HlpClosed' || eventName === 'HlpTerminalLiquidated') {
    const target = side(eventName === 'HlpClosed' ? event.asset_side : event.target_asset);
    amounts.push({ metric: 'reportedInterest',amount: unsigned(event.interest_paid).toString(),asset: { side: target === 0 ? 1 : 0 } });
  }
  return { market,hasSwap: swap !== null,amounts };
}

export interface ActivityPriceBasis {
  /** The latest prior-slot swap snapshot, which quotes the market's spot
   * price. Null before the market's first swap, when only the mints' own
   * prices apply. */
  capture: { id: string; slot: number; blockTime: string } | null;
  bound: { baseMint: string; quoteMint: string; baseDecimals: number; quoteDecimals: number };
  spotPrices?: { base: string; quote: string };
  prices: { mint: string; decimals: number; priceUsd: string; quality: string; observationId?: string }[];
  /** The market's mints that the dated reference policy marks as USD stablecoins. */
  stablecoins?: string[];
}

export interface ActivityExternalPrice {
  observationId: string; mint: string; decimals: number; priceUsd: string; sourceTime: string; observedAt: string; estimated?: boolean;
}

/** Direct provider quote, then on-chain ratio to a provider quote, then the
 * captured devnet reference. A USD stablecoin keeps its peg rather than a
 * counterasset's quote times the curve. No current quote is applied to a
 * past event. */
export function activityPriceBasis(basis: ActivityPriceBasis,external: ActivityExternalPrice[],eventTime: string): ActivityPriceBasis {
  const valid = external.filter((price) => {
    const time = Date.parse(price.sourceTime),observed = Date.parse(price.observedAt),event = Date.parse(eventTime);
    return Number.isFinite(time) && Number.isFinite(observed) && time<=observed && observed<=event;
  });
  const prices = (['base','quote'] as const).flatMap((side) => {
    const mint = side === 'base' ? basis.bound.baseMint : basis.bound.quoteMint;
    const otherMint = side === 'base' ? basis.bound.quoteMint : basis.bound.baseMint;
    const decimals = side === 'base' ? basis.bound.baseDecimals : basis.bound.quoteDecimals;
    const otherDecimals = side === 'base' ? basis.bound.quoteDecimals : basis.bound.baseDecimals;
    const own = valid.find((price) => price.mint === mint && price.decimals === decimals);
    if (own) return [{ mint,decimals,priceUsd: own.priceUsd,quality: own.estimated ? 'external-reference' : 'external-observation',observationId: own.observationId }];
    const other = basis.stablecoins?.includes(mint) ? undefined : valid.find((price) => price.mint === otherMint && price.decimals === otherDecimals);
    const spot = BigInt(basis.spotPrices?.[side] ?? '0');
    if (other && spot>0n) return [{ mint,decimals,priceUsd: multiplyPriceRatio(other.priceUsd,spot,1_000_000_000n),
      quality: 'derived-reference',observationId: other.observationId }];
    return basis.prices.filter((price) => price.mint === mint);
  });
  return { ...basis,prices };
}

/** One observed trade is valued once, at an as-of price: from its USD
 * stablecoin leg when it has one, the cash that changed hands, otherwise from
 * its input. Every other amount is valued in its own asset. */
export function valueActivityAmounts(amounts: ActivityAmount[],price: ActivityPriceBasis | null,eventSlot: number,eventTime: string) {
  if (!Number.isSafeInteger(eventSlot) || eventSlot<0 || !Number.isFinite(Date.parse(eventTime)))
    throw new Error('Invalid native activity valuation boundary');
  // A captured bank has no transaction-order boundary within its slot. A
  // same-slot quote could already include the trade being valued.
  const capture = price?.capture ?? null;
  if (capture && (!Number.isSafeInteger(capture.slot) || capture.slot>=eventSlot || capture.slot<0
    || !Number.isFinite(Date.parse(capture.blockTime)) || Date.parse(capture.blockTime)>Date.parse(eventTime)))
    throw new Error('Native activity price is outside the event-time boundary');
  if (price && !capture && (price.spotPrices || price.prices.some((quote) => quote.quality === 'derived-reference')))
    throw new Error('Native activity price derives from a missing snapshot');
  const mintOf = (asset: ActivityAmount['asset']) => 'mint' in asset ? asset.mint : price
    ? asset.side === 0 ? price.bound.baseMint : price.bound.quoteMint : null;
  const stablecoins = new Set(price?.stablecoins),stable = (asset: ActivityAmount['asset']) => stablecoins.has(mintOf(asset) ?? '');
  const valued = (amount: string,asset: ActivityAmount['asset']) => {
    const mint = mintOf(asset);
    if (price && mint !== price.bound.baseMint && mint !== price.bound.quoteMint)
      throw new Error('Native activity amount mint is outside its market');
    const quote = price?.prices.find((candidate) => candidate.mint === mint);
    if (!price || !quote) return null;
    const decimals = mint === price.bound.baseMint ? price.bound.baseDecimals : mint === price.bound.quoteMint ? price.bound.quoteDecimals : null;
    if (decimals === null || quote.decimals !== decimals || !Number.isInteger(decimals) || decimals<0 || decimals>255 || usdUnits(quote.priceUsd)<=0n)
      throw new Error('Native activity price mint/decimals mismatch');
    return { amount,asset,usd: formatUsd(unsigned(amount)*usdUnits(quote.priceUsd)/10n**BigInt(decimals)),
      priceCaptureId: capture?.id ?? null,priceQuality: quote.quality,priceObservationId: quote.observationId ?? null };
  };
  return amounts.map(({ output,...entry }) => {
    if (unsigned(entry.amount) === 0n) return { ...entry,usd: '0',priceCaptureId: null,priceQuality: null,priceObservationId: null };
    const input = valued(entry.amount,entry.asset);
    // An unpriced stablecoin leg leaves the trade to its input's price.
    const leg = output && stable(output.asset) && !stable(entry.asset) ? valued(output.amount,output.asset) : null;
    return { ...entry,...(leg ?? input ?? { usd: null,priceCaptureId: null,priceQuality: null,priceObservationId: null }) };
  });
}
