/**
 * Market state, read from chain through the pinned IDL.
 *
 * Markets are discovered from the configured devnet program. Each market
 * carries its own mints, decimals and associated account addresses.
 *
 * Health values (effective debt, debt health) are not stored on the account —
 * they come from simulating the program's `preview_market` instruction, which
 * needs no signature and no funded payer beyond an account that exists.
 */

import * as anchor from '@coral-xyz/anchor';
import {
  Connection,
  PublicKey,
} from '@solana/web3.js';
import { readFileSync } from 'fs';
import { resolve } from 'path';

import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, unpackMint } from '@solana/spl-token';
import {
  DUSK_DEPLOYMENT_COMMITMENT,
  duskApiConfig, loadPinnedProtocol,
} from '../config/duskProtocol';
import { deploymentEnvelope } from './duskDeploymentService';
import { cache } from '../utils/cache';
import { captureLiveMarketSimulation, duskRawIdl, LiveMarketSimulationSnapshot } from './duskMarketSimulation';
import { indexedPortfolioDebt } from './duskPortfolioMath';
import { parsePriceReferences, projectMarketPrices } from './duskPriceMath';

const NAD = 1_000_000_000n;

/** Unit amplification is the constant-product curve; above it concentrates. */
function marketKindFromConfig(config: Record<string, unknown>): string {
  const amm = config.amm as Record<string, unknown> | undefined;
  const raw = amm?.peakAmplificationNad;
  try {
    return BigInt(String(raw ?? '0')) > NAD ? 'concentrated' : 'cpmm';
  } catch {
    return 'cpmm';
  }
}

/** Anchor decodes to camelCase; snake_case is accepted for hand-built data. */
function field<T = unknown>(
  source: unknown,
  camel: string,
  snake?: string,
): T {
  const record = (source ?? {}) as Record<string, unknown>;
  const value = record[camel] ?? (snake ? record[snake] : undefined);
  return value as T;
}

/** Anchor hands back BN, bigint, number or string depending on the width. */
function stringValue(value: unknown): string {
  if (value === null || value === undefined) return '0';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'bigint') return value.toString();
  if (typeof (value as { toString?: unknown }).toString === 'function') {
    return (value as { toString(): string }).toString();
  }
  return '0';
}

function toBigInt(value: unknown): bigint {
  try {
    return BigInt(stringValue(value));
  } catch {
    return 0n;
  }
}

function numberValue(value: unknown, fallback = 0): number {
  const parsed = Number(stringValue(value));
  return Number.isFinite(parsed) ? parsed : fallback;
}

interface Runtime {
  connection: Connection;
  program: anchor.Program;
}

let runtime: Runtime | undefined;

function initializeRuntime(): Runtime {
  if (runtime) return runtime;
  const config = duskApiConfig();

  const connection = new Connection(config.rpcUrl, DUSK_DEPLOYMENT_COMMITMENT);
  const idlPath = resolve(
    process.env.DUSK_PROTOCOL_DIR?.trim() ||
      resolve(__dirname, '../../../protocol'),
    'idl/dusk.json',
  );
  const idl = JSON.parse(readFileSync(idlPath, 'utf8')) as anchor.Idl;

  // Reads and simulations only; no wallet is ever asked to sign.
  const provider = new anchor.AnchorProvider(
    connection,
    {} as anchor.Wallet,
    { commitment: DUSK_DEPLOYMENT_COMMITMENT },
  );
  const program = new anchor.Program(idl, provider);

  runtime = { connection, program };
  return runtime;
}

/** Cached complete snapshots may only satisfy reads at or after their floor. */
export async function currentMarketSnapshot(market: PublicKey, discovery: unknown, minSlot: number, identity: string,
  capture: typeof captureLiveMarketSimulation = captureLiveMarketSimulation): Promise<LiveMarketSimulationSnapshot> {
  const key = `dusk:market_snapshot:${identity}:${market.toBase58()}`;
  const previous = cache.get(key) as LiveMarketSimulationSnapshot | null;
  if (previous && previous.slot>=minSlot) return previous;
  const mints = ['base','quote'].map((side) => stringValue(field(field(discovery,`${side}Side`,`${side}_side`),'assetMint','asset_mint')));
  const snapshot = await cache.getOrSet(`${key}:floor:${minSlot}`,0,() => capture(market.toBase58(),minSlot,mints));
  if (snapshot.commitment !== 'confirmed' || snapshot.slot<minSlot || snapshot.market !== market.toBase58()
    || snapshot.deploymentIdentitySha256 !== identity) throw new Error('Live market snapshot identity or slot mismatch');
  const current = cache.get(key) as LiveMarketSimulationSnapshot | null;
  if (!current || current.slot<snapshot.slot) cache.set(key,snapshot,5000);
  return snapshot;
}

function marketConfigPayload(marketAccount: unknown): Record<string, unknown> {
  const config = field<Record<string, unknown>>(marketAccount, 'config');
  const amm = field<Record<string, unknown>>(config, 'amm');
  const irm = field<Record<string, unknown>>(config, 'irm');

  return {
    swapFeeBps: numberValue(field(config, 'swapFeeBps', 'swap_fee_bps')),
    divergenceFeeShareCapBps: numberValue(
      field(config, 'divergenceFeeShareCapBps', 'divergence_fee_share_cap_bps'),
    ),
    volatilityFeeShareCapBps: numberValue(
      field(config, 'volatilityFeeShareCapBps', 'volatility_fee_share_cap_bps'),
    ),
    targetHlpLeverageBps: numberValue(
      field(config, 'targetHlpLeverageBps', 'target_hlp_leverage_bps'),
    ),
    settlementDivergenceBps: numberValue(
      field(config, 'settlementDivergenceBps', 'settlement_divergence_bps'),
    ),
    emaHalfLifeMs: stringValue(field(config, 'emaHalfLifeMs', 'ema_half_life_ms')),
    directionalEmaHalfLifeMs: stringValue(
      field(config, 'directionalEmaHalfLifeMs', 'directional_ema_half_life_ms'),
    ),
    // The read model still calls this the q-EMA; on chain it is the curve
    // depth EMA. Same value, older name on the client.
    qEmaHalfLifeMs: stringValue(
      field(config, 'curveDepthEmaHalfLifeMs', 'curve_depth_ema_half_life_ms'),
    ),
    maxDailyBorrowBps: numberValue(
      field(config, 'maxDailyBorrowBps', 'max_daily_borrow_bps'),
    ),
    globalHealthContributionCapBps: numberValue(
      field(
        config,
        'globalHealthContributionCapBps',
        'global_health_contribution_cap_bps',
      ),
    ),
    borrowMarketHealthFloorBps: numberValue(
      field(config, 'borrowMarketHealthFloorBps', 'borrow_market_health_floor_bps'),
    ),
    startTime: stringValue(field(config, 'startTime', 'start_time')),
    amm: {
      peakAmplificationNad: stringValue(
        field(amm, 'peakAmplificationNad', 'peak_amplification_nad'),
      ),
      coreHalfWidthBps: numberValue(
        field(amm, 'coreHalfWidthBps', 'core_half_width_bps'),
      ),
      fadeWidthBps: numberValue(field(amm, 'fadeWidthBps', 'fade_width_bps')),
      centerEmaHalfLifeMs: stringValue(
        field(amm, 'centerEmaHalfLifeMs', 'center_ema_half_life_ms'),
      ),
      volatilityHalfLifeMs: stringValue(
        field(amm, 'volatilityHalfLifeMs', 'volatility_half_life_ms'),
      ),
      adjustmentThresholdNad: stringValue(
        field(amm, 'adjustmentThresholdNad', 'adjustment_threshold_nad'),
      ),
      adjustmentStepNad: stringValue(
        field(amm, 'adjustmentStepNad', 'adjustment_step_nad'),
      ),
      minAdjustmentIntervalSlots: stringValue(
        field(amm, 'minAdjustmentIntervalSlots', 'min_adjustment_interval_slots'),
      ),
      volatilityShockCapNad: stringValue(
        field(amm, 'volatilityShockCapNad', 'volatility_shock_cap_nad'),
      ),
      volatilityCapNad: stringValue(
        field(amm, 'volatilityCapNad', 'volatility_cap_nad'),
      ),
      divergenceFeeCoefficientNad: stringValue(
        field(amm, 'divergenceFeeCoefficientNad', 'divergence_fee_coefficient_nad'),
      ),
      volatilityFeeCoefficientNad: stringValue(
        field(amm, 'volatilityFeeCoefficientNad', 'volatility_fee_coefficient_nad'),
      ),
      reserved: Array.from(
        (field<number[]>(amm, 'reserved') ?? []) as number[],
      ).map((byte) => Number(byte)),
    },
    irm: {
      targetUtilizationBps: numberValue(
        field(irm, 'targetUtilizationBps', 'target_utilization_bps'),
      ),
      curveSteepnessNad: stringValue(
        field(irm, 'curveSteepnessNad', 'curve_steepness_nad'),
      ),
      adjustmentSpeedPerYear: stringValue(
        field(irm, 'adjustmentSpeedPerYear', 'adjustment_speed_per_year'),
      ),
    },
  };
}

export interface DuskMarketAssociatedAddresses {
  baseMint: string;
  quoteMint: string;
  baseDecimals: number;
  quoteDecimals: number;
  baseTokenProgram: string;
  quoteTokenProgram: string;
  ylpMint: string;
  baseHlpMint: string;
  quoteHlpMint: string;
  baseReserveVault: string;
  quoteReserveVault: string;
  baseCollateralVault: string;
  quoteCollateralVault: string;
  baseInsuranceVault: string;
  quoteInsuranceVault: string;
  baseInterestVault: string;
  quoteInterestVault: string;
  baseHlpYlpVault: string;
  quoteHlpYlpVault: string;
}

function pda(seeds: (Buffer | Uint8Array)[], programId: PublicKey): string {
  return PublicKey.findProgramAddressSync(seeds, programId)[0].toBase58();
}

/**
 * Every address a market implies.
 *
 * The account already stores its mints, decimals, HLP mints and the reserve,
 * collateral and interest vaults, so almost nothing needs deriving — only the
 * insurance and HLP/YLP vaults, whose seeds come from the IDL. The token
 * programs are the mints' owners, which is the one thing that has to be read.
 */
function associatedAddresses(
  market: PublicKey,
  marketAccount: unknown,
  snapshot: LiveMarketSimulationSnapshot,
): DuskMarketAssociatedAddresses {
  const programId = new PublicKey(loadPinnedProtocol().dusk.programId);
  const baseSide = field<Record<string, unknown>>(marketAccount, 'baseSide', 'base_side');
  const quoteSide = field<Record<string, unknown>>(marketAccount, 'quoteSide', 'quote_side');

  const baseMint = new PublicKey(stringValue(field(baseSide, 'assetMint', 'asset_mint')));
  const quoteMint = new PublicKey(stringValue(field(quoteSide, 'assetMint', 'asset_mint')));
  const baseHlpMint = stringValue(field(baseSide, 'hlpMint', 'hlp_mint'));
  const quoteHlpMint = stringValue(field(quoteSide, 'hlpMint', 'hlp_mint'));
  const ylpMint = stringValue(field(marketAccount, 'ylpMint', 'ylp_mint'));

  const readMint = (mint: PublicKey,decimals: number) => {
    const account = snapshot.accounts.find((entry) => entry.address === mint.toBase58())?.account;
    if (!account || account.executable) throw new Error('Market snapshot omits a mint');
    const owner = new PublicKey(account.owner);
    if (!owner.equals(TOKEN_PROGRAM_ID) && !owner.equals(TOKEN_2022_PROGRAM_ID)) throw new Error('Market mint has an invalid token program');
    const decoded = unpackMint(mint,{ owner,executable: false,data: Buffer.from(account.data,'base64'),lamports: 0 },owner);
    if (!decoded.isInitialized || decoded.decimals !== decimals) throw new Error('Market mint decimals or initialization mismatch');
    return { owner };
  };
  const baseDecimals = numberValue(field(baseSide,'assetDecimals','asset_decimals'));
  const quoteDecimals = numberValue(field(quoteSide,'assetDecimals','asset_decimals'));
  const baseMintInfo = readMint(baseMint,baseDecimals),quoteMintInfo = readMint(quoteMint,quoteDecimals);

  const marketBytes = market.toBuffer();
  const seed = (text: string) => Buffer.from(text, 'utf8');
  const hlpYlpVault = (hlpMint: string) =>
    pda(
      [
        seed('hlp_ylp_vault'),
        marketBytes,
        new PublicKey(hlpMint).toBuffer(),
        new PublicKey(ylpMint).toBuffer(),
      ],
      programId,
    );

  return {
    baseMint: baseMint.toBase58(),
    quoteMint: quoteMint.toBase58(),
    baseDecimals,
    quoteDecimals,
    baseTokenProgram: baseMintInfo.owner.toBase58(),
    quoteTokenProgram: quoteMintInfo.owner.toBase58(),
    ylpMint,
    baseHlpMint,
    quoteHlpMint,
    baseReserveVault: stringValue(field(baseSide, 'reserveVault', 'reserve_vault')),
    quoteReserveVault: stringValue(field(quoteSide, 'reserveVault', 'reserve_vault')),
    baseCollateralVault: stringValue(field(baseSide, 'collateralVault', 'collateral_vault')),
    quoteCollateralVault: stringValue(field(quoteSide, 'collateralVault', 'collateral_vault')),
    baseInsuranceVault: pda([seed('insurance'), marketBytes, baseMint.toBuffer()], programId),
    quoteInsuranceVault: pda([seed('insurance'), marketBytes, quoteMint.toBuffer()], programId),
    baseInterestVault: stringValue(field(baseSide, 'interestVault', 'interest_vault')),
    quoteInterestVault: stringValue(field(quoteSide, 'interestVault', 'interest_vault')),
    baseHlpYlpVault: hlpYlpVault(baseHlpMint),
    quoteHlpYlpVault: hlpYlpVault(quoteHlpMint),
  };
}

export async function marketPayload(
  market: PublicKey,
  marketAccount: unknown,
  sourceSlot: number,
  deploymentIdentity?: string,
): Promise<Record<string, unknown>> {
  const identity = deploymentIdentity ?? (await deploymentEnvelope()).deploymentIdentitySha256;
  const snapshot = await currentMarketSnapshot(market,marketAccount,sourceSlot,identity);
  return projectMarketSnapshot(snapshot);
}

/** One bank supplies the updated market, its preview, and both mint accounts. */
export function projectMarketSnapshot(snapshot: LiveMarketSimulationSnapshot, referencesInput?: unknown): Record<string, unknown> {
  const market = new PublicKey(snapshot.market),sourceSlot = snapshot.slot,decoder = new anchor.BorshCoder(duskRawIdl());
  const marketAccount = decoder.accounts.decode('Market',Buffer.from(snapshot.marketAccount.data,'base64'));
  const preview = snapshot.preview === null ? null : decoder.types.decode('MarketPreview',Buffer.from(snapshot.preview,'base64'));
  const health = field(preview,'health');
  const healthValue = (camel: string,snake: string) => preview === null ? null : stringValue(field(health,camel,snake));
  const previewValue = (side: 'base' | 'quote',camel: string,snake: string) => preview === null ? null : stringValue(field(field(preview,side),camel,snake));
  const config = marketConfigPayload(marketAccount);
  const addresses = associatedAddresses(market,marketAccount,snapshot);
  const pin = loadPinnedProtocol();
  const references = parsePriceReferences(referencesInput ?? JSON.parse(readFileSync(process.env.DUSK_PRICE_REFERENCES_FILE?.trim()
    || resolve(process.env.DUSK_PROTOCOL_DIR?.trim() || resolve(__dirname,'../../../protocol'),'devnet-price-references.json'),'utf8')),pin);
  const priceProjection = preview === null ? null : projectMarketPrices({ pin,marketAddress: snapshot.market,market: marketAccount,
    preview,slot: sourceSlot,blockTime: snapshot.blockTime,references });

  const baseSide = field<Record<string, unknown>>(marketAccount, 'baseSide', 'base_side');
  const quoteSide = field<Record<string, unknown>>(marketAccount, 'quoteSide', 'quote_side');
  const baseReserves = field(baseSide, 'reserves');
  const quoteReserves = field(quoteSide, 'reserves');
  const baseFees = field(baseSide, 'fees');
  const quoteFees = field(quoteSide, 'fees');
  const baseBucket = field(baseSide, 'dailyBorrowBucket', 'daily_borrow_bucket');
  const quoteBucket = field(quoteSide, 'dailyBorrowBucket', 'daily_borrow_bucket');
  const debt = field(marketAccount, 'debt');
  const insurance = field(marketAccount, 'insurance');

  const fixedBaseShares = toBigInt(field(debt, 'fixedBaseShares', 'fixed_base_shares'));
  const fixedQuoteShares = toBigInt(field(debt, 'fixedQuoteShares', 'fixed_quote_shares'));
  const baseBorrowIndexNad = toBigInt(
    field(debt, 'baseBorrowIndexNad', 'base_borrow_index_nad'),
  );
  const quoteBorrowIndexNad = toBigInt(
    field(debt, 'quoteBorrowIndexNad', 'quote_borrow_index_nad'),
  );

  return {
    label: `${addresses.baseMint.slice(0, 4)}/${addresses.quoteMint.slice(0, 4)}`,
    marketKind: marketKindFromConfig(config),
    marketAddress: market.toBase58(),
    ...addresses,
    targetHlpLeverageBps: config.targetHlpLeverageBps,
    swapFeeBps: config.swapFeeBps,
    config,
    governanceLockedYlp: stringValue(
      field(marketAccount, 'governanceLockedYlp', 'governance_locked_ylp'),
    ),
    parameterRevisions: Array.from(
      (field<unknown[]>(marketAccount, 'parameterRevisions', 'parameter_revisions') ??
        []) as unknown[],
    ).map(stringValue),
    paramsHash: Buffer.from(
      (field<number[]>(marketAccount, 'paramsHash', 'params_hash') ?? []) as number[],
    ).toString('hex'),
    version: numberValue(field(marketAccount, 'version'), 1),
    reduceOnly: Boolean(field(marketAccount, 'reduceOnly', 'reduce_only') ?? false),
    createdTxSig: null,
    createdSlot: null,
    createdAt: null,
    updatedAt: null,
    observedAt: snapshot.blockTime,
    swapCount: 0,
    lastSwapAt: null,
    displayPrices: { schemaVersion: 'dusk-market-prices.v1',protocolRevision: pin.revision,sourceSlot,
      observedAt: snapshot.blockTime,referenceEffectiveFrom: references.effectiveFrom,
      referenceHash: priceProjection?.referenceHash ?? null,prices: priceProjection?.prices ?? [] },
    state: {
      baseLiveReserve: stringValue(field(baseReserves, 'liveReserve', 'live_reserve')),
      quoteLiveReserve: stringValue(field(quoteReserves, 'liveReserve', 'live_reserve')),
      baseCashReserve: stringValue(field(baseReserves, 'cashReserve', 'cash_reserve')),
      quoteCashReserve: stringValue(field(quoteReserves, 'cashReserve', 'cash_reserve')),
      baseSideYlpSupply: stringValue(
        field(field(baseSide, 'shares'), 'ylpSupply', 'ylp_supply'),
      ),
      quoteSideYlpSupply: stringValue(
        field(field(quoteSide, 'shares'), 'ylpSupply', 'ylp_supply'),
      ),
      fixedBaseShares: fixedBaseShares.toString(),
      fixedQuoteShares: fixedQuoteShares.toString(),
      fixedBaseDebt: indexedPortfolioDebt(fixedBaseShares,baseBorrowIndexNad).toString(),
      fixedQuoteDebt: indexedPortfolioDebt(fixedQuoteShares,quoteBorrowIndexNad).toString(),
      fixedBasePrincipal: stringValue(field(debt, 'fixedBasePrincipal', 'fixed_base_principal')),
      fixedQuotePrincipal: stringValue(field(debt, 'fixedQuotePrincipal', 'fixed_quote_principal')),
      baseBorrowIndexNad: baseBorrowIndexNad.toString(),
      quoteBorrowIndexNad: quoteBorrowIndexNad.toString(),
      isolatedBaseShares: stringValue(field(debt, 'isolatedBaseShares', 'isolated_base_shares')),
      isolatedQuoteShares: stringValue(field(debt, 'isolatedQuoteShares', 'isolated_quote_shares')),
      isolatedBasePrincipal: stringValue(
        field(debt, 'isolatedBasePrincipal', 'isolated_base_principal'),
      ),
      isolatedQuotePrincipal: stringValue(
        field(debt, 'isolatedQuotePrincipal', 'isolated_quote_principal'),
      ),
      baseInsuranceAvailable: stringValue(field(insurance, 'baseAvailable', 'base_available')),
      quoteInsuranceAvailable: stringValue(field(insurance, 'quoteAvailable', 'quote_available')),
      baseSwapFeeCustodyBalance: stringValue(
        field(baseFees, 'swapFeeCustodyBalance', 'swap_fee_custody_balance'),
      ),
      quoteSwapFeeCustodyBalance: stringValue(
        field(quoteFees, 'swapFeeCustodyBalance', 'swap_fee_custody_balance'),
      ),
      baseSwapProtocolFeeLiability: stringValue(
        field(baseFees, 'swapProtocolFeeLiability', 'swap_protocol_fee_liability'),
      ),
      quoteSwapProtocolFeeLiability: stringValue(
        field(quoteFees, 'swapProtocolFeeLiability', 'swap_protocol_fee_liability'),
      ),
      baseInterestProtocolFeeLiability: stringValue(
        field(baseFees, 'interestProtocolFeeLiability', 'interest_protocol_fee_liability'),
      ),
      quoteInterestProtocolFeeLiability: stringValue(
        field(quoteFees, 'interestProtocolFeeLiability', 'interest_protocol_fee_liability'),
      ),
      baseSwapBuybackFeeLiability: stringValue(
        field(baseFees, 'swapBuybackFeeLiability', 'swap_buyback_fee_liability'),
      ),
      quoteSwapBuybackFeeLiability: stringValue(
        field(quoteFees, 'swapBuybackFeeLiability', 'swap_buyback_fee_liability'),
      ),
      baseInterestBuybackFeeLiability: stringValue(
        field(baseFees, 'interestBuybackFeeLiability', 'interest_buyback_fee_liability'),
      ),
      quoteInterestBuybackFeeLiability: stringValue(
        field(quoteFees, 'interestBuybackFeeLiability', 'interest_buyback_fee_liability'),
      ),
      baseLpSwapFeeLiability: stringValue(field(baseFees, 'swapFeeLiability', 'swap_fee_liability')),
      quoteLpSwapFeeLiability: stringValue(
        field(quoteFees, 'swapFeeLiability', 'swap_fee_liability'),
      ),
      baseLpInterestFeeLiability: stringValue(
        field(baseFees, 'interestLiability', 'interest_liability'),
      ),
      quoteLpInterestFeeLiability: stringValue(
        field(quoteFees, 'interestLiability', 'interest_liability'),
      ),
      baseUnallocatedSwapFeeLiability: stringValue(
        field(baseFees, 'unallocatedSwapFeeLiability', 'unallocated_swap_fee_liability'),
      ),
      quoteUnallocatedSwapFeeLiability: stringValue(
        field(quoteFees, 'unallocatedSwapFeeLiability', 'unallocated_swap_fee_liability'),
      ),
      baseDailyBorrowedBucket: stringValue(
        field(baseBucket, 'borrowedBucket', 'borrowed_bucket'),
      ),
      quoteDailyBorrowedBucket: stringValue(
        field(quoteBucket, 'borrowedBucket', 'borrowed_bucket'),
      ),
      baseDailyLastDecaySlot: stringValue(
        field(baseBucket, 'lastDecaySlot', 'last_decay_slot'),
      ),
      quoteDailyLastDecaySlot: stringValue(
        field(quoteBucket, 'lastDecaySlot', 'last_decay_slot'),
      ),
      baseDailyDecayRemainderMs: stringValue(
        field(baseBucket, 'decayRemainderMs', 'decay_remainder_ms'),
      ),
      quoteDailyDecayRemainderMs: stringValue(
        field(quoteBucket, 'decayRemainderMs', 'decay_remainder_ms'),
      ),
      globalHealthBaseContributionForQuoteDebt: stringValue(
        field(
          debt,
          'globalHealthBaseContributionForQuoteDebt',
          'global_health_base_contribution_for_quote_debt',
        ),
      ),
      globalHealthQuoteContributionForBaseDebt: stringValue(
        field(
          debt,
          'globalHealthQuoteContributionForBaseDebt',
          'global_health_quote_contribution_for_base_debt',
        ),
      ),
      effectiveBaseDebtNad: healthValue('effectiveBaseDebtNad','effective_base_debt_nad'),
      effectiveQuoteDebtNad: healthValue('effectiveQuoteDebtNad','effective_quote_debt_nad'),
      baseDebtHealthBps: healthValue('baseDebtHealthBps','base_debt_health_bps'),
      quoteDebtHealthBps: healthValue('quoteDebtHealthBps','quote_debt_health_bps'),
      baseBorrowAprNad: previewValue('base','borrowAprNad','borrow_apr_nad'),
      quoteBorrowAprNad: previewValue('quote','borrowAprNad','borrow_apr_nad'),
      baseUtilizationBps: previewValue('base','utilizationBps','utilization_bps'),
      quoteUtilizationBps: previewValue('quote','utilizationBps','utilization_bps'),
      basePriceEmaNad: previewValue('base','priceEmaNad','price_ema_nad'),
      quotePriceEmaNad: previewValue('quote','priceEmaNad','price_ema_nad'),
      baseSpotPriceNad: previewValue('base','spotPriceNad','spot_price_nad'),
      quoteSpotPriceNad: previewValue('quote','spotPriceNad','spot_price_nad'),
      baseTotalDebt: previewValue('base','totalDebt','total_debt'),
      quoteTotalDebt: previewValue('quote','totalDebt','total_debt'),
      baseIsolatedDebt: previewValue('base','isolatedDebt','isolated_debt'),
      quoteIsolatedDebt: previewValue('quote','isolatedDebt','isolated_debt'),
      baseHlpFundingDebt: previewValue('base','hlpFundingDebt','hlp_funding_debt'),
      quoteHlpFundingDebt: previewValue('quote','hlpFundingDebt','hlp_funding_debt'),
      stateBasis: snapshot.basis,
      previewStatus: preview === null ? 'unavailable' : 'available',
      healthSourceSlot: preview === null ? null : sourceSlot,
      healthObservedAt: preview === null ? null : snapshot.blockTime,
      sourceTxSig: null,
      sourceSlot,
      observedAt: snapshot.blockTime,
    },
  };
}

export interface DiscoveredMarket {
  address: PublicKey;
  account: unknown;
}

/** Every Market account the program owns, at the observed slot. */
export async function discoverMarkets(): Promise<{
  markets: DiscoveredMarket[];
  sourceSlot: number;
}> {
  const { connection, program } = initializeRuntime();
  const observation = await connection.getProgramAccounts(program.programId, {
    commitment: DUSK_DEPLOYMENT_COMMITMENT,
    withContext: true,
    filters: [{ memcmp: program.coder.accounts.memcmp('market') }],
  });
  return {
    markets: observation.value.map((entry) => {
      if (!entry.account.owner.equals(program.programId)) throw new Error('Market account owner mismatch');
      return { address: entry.pubkey, account: program.coder.accounts.decode('market', entry.account.data) };
    }),
    sourceSlot: observation.context.slot,
  };
}

export async function fetchMarket(address: PublicKey): Promise<{
  account: unknown;
  sourceSlot: number;
}> {
  const { program } = initializeRuntime();
  const namespace = program.account as unknown as Record<
    string,
    {
      fetchAndContext(
        address: PublicKey,
        commitment: string,
      ): Promise<{ data: unknown; context: { slot: number } }>;
    }
  >;
  const observation = await namespace.market.fetchAndContext(
    address,
    DUSK_DEPLOYMENT_COMMITMENT,
  );
  return { account: observation.data, sourceSlot: observation.context.slot };
}
