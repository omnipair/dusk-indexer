/**
 * Market state, read from chain through the pinned IDL.
 *
 * Markets are discovered rather than declared: the fork lab knew its two
 * bootstrapped markets from a manifest it wrote itself, but a real cluster has
 * whatever markets people created, so this enumerates the program's Market
 * accounts and derives every associated address from the account and its
 * mints.
 *
 * Health values (effective debt, debt health) are not stored on the account —
 * they come from simulating the program's `preview_market` instruction, which
 * needs no signature and no funded payer beyond an account that exists.
 */

import * as anchor from '@coral-xyz/anchor';
import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  Transaction,
} from '@solana/web3.js';
import { readFileSync } from 'fs';
import { resolve } from 'path';

import pool from '../config/database';
import {
  DUSK_DEPLOYMENT_COMMITMENT,
  duskApiConfig,
} from '../config/duskProtocol';
import { deploymentEnvelope } from './duskDeploymentService';

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

/**
 * Simulation needs a fee payer that exists on chain but never signs. The
 * program's upgrade authority is guaranteed to exist for an upgradeable
 * deployment; an immutable program needs DUSK_PREVIEW_PAYER set explicitly.
 */
async function resolvePreviewPayer(): Promise<PublicKey> {
  const configured = process.env.DUSK_PREVIEW_PAYER?.trim();
  if (configured) return new PublicKey(configured);
  const envelope = await deploymentEnvelope();
  if (!envelope.programUpgradeAuthority) {
    throw new Error(
      'DUSK_PREVIEW_PAYER must be set: the program is immutable, so it has no upgrade authority to borrow as a simulation fee payer',
    );
  }
  return new PublicKey(envelope.programUpgradeAuthority);
}

async function currentMarketHealth(market: PublicKey) {
  const { connection, program } = initializeRuntime();
  const previewPayer = await resolvePreviewPayer();
  const instruction = await program.methods
    .previewMarket()
    .accounts({ market })
    .instruction();
  const transaction = new Transaction().add(
    ComputeBudgetProgram.requestHeapFrame({ bytes: 256 * 1024 }),
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
    instruction,
  );
  transaction.feePayer = previewPayer;
  transaction.recentBlockhash = (
    await connection.getLatestBlockhash(DUSK_DEPLOYMENT_COMMITMENT)
  ).blockhash;

  const simulation = await connection.simulateTransaction(transaction);
  if (simulation.value.err) {
    throw new Error(
      `preview_market simulation failed: ${JSON.stringify(simulation.value.err)}`,
    );
  }
  const returnData = simulation.value.returnData;
  if (!returnData || returnData.programId !== program.programId.toBase58()) {
    throw new Error('preview_market simulation returned no Dusk data');
  }
  const preview = program.coder.types.decode(
    'marketPreview',
    Buffer.from(returnData.data[0], returnData.data[1] as BufferEncoding),
  );
  return {
    health: field<Record<string, unknown>>(preview, 'health'),
    sourceSlot: simulation.context.slot,
  };
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
async function associatedAddresses(
  market: PublicKey,
  marketAccount: unknown,
): Promise<DuskMarketAssociatedAddresses> {
  const { connection, program } = initializeRuntime();
  const programId = program.programId;
  const baseSide = field<Record<string, unknown>>(marketAccount, 'baseSide', 'base_side');
  const quoteSide = field<Record<string, unknown>>(marketAccount, 'quoteSide', 'quote_side');

  const baseMint = new PublicKey(stringValue(field(baseSide, 'assetMint', 'asset_mint')));
  const quoteMint = new PublicKey(stringValue(field(quoteSide, 'assetMint', 'asset_mint')));
  const baseHlpMint = stringValue(field(baseSide, 'hlpMint', 'hlp_mint'));
  const quoteHlpMint = stringValue(field(quoteSide, 'hlpMint', 'hlp_mint'));
  const ylpMint = stringValue(field(marketAccount, 'ylpMint', 'ylp_mint'));

  const [baseMintInfo, quoteMintInfo] = await connection.getMultipleAccountsInfo(
    [baseMint, quoteMint],
    DUSK_DEPLOYMENT_COMMITMENT,
  );
  if (!baseMintInfo || !quoteMintInfo) {
    throw new Error(`market ${market.toBase58()} references a missing mint`);
  }

  const baseDecimals = numberValue(field(baseSide, 'assetDecimals', 'asset_decimals'));
  const quoteDecimals = numberValue(field(quoteSide, 'assetDecimals', 'asset_decimals'));
  // Decimals are needed to turn raw reserves into value, and the mint accounts
  // are the only place they live. This is the one point where the API already
  // has them, so it records them for the valuation views.
  void recordTokenMetadata([
    { mint: baseMint.toBase58(), decimals: baseDecimals, tokenProgram: baseMintInfo.owner.toBase58() },
    { mint: quoteMint.toBase58(), decimals: quoteDecimals, tokenProgram: quoteMintInfo.owner.toBase58() },
  ]);

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
): Promise<Record<string, unknown>> {
  const { connection } = initializeRuntime();
  const healthObservation = await currentMarketHealth(market);
  const health = healthObservation.health;

  const [sourceBlockTime, healthBlockTime] = await Promise.all([
    connection.getBlockTime(sourceSlot).catch(() => null),
    connection.getBlockTime(healthObservation.sourceSlot).catch(() => null),
  ]);
  const iso = (seconds: number | null) =>
    seconds === null ? null : new Date(seconds * 1_000).toISOString();

  const config = marketConfigPayload(marketAccount);
  const addresses = await associatedAddresses(market, marketAccount);

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
    observedAt: iso(sourceBlockTime),
    swapCount: 0,
    lastSwapAt: null,
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
      fixedBaseDebt: ((fixedBaseShares * baseBorrowIndexNad) / NAD).toString(),
      fixedQuoteDebt: ((fixedQuoteShares * quoteBorrowIndexNad) / NAD).toString(),
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
      effectiveBaseDebtNad: stringValue(
        field(health, 'effectiveBaseDebtNad', 'effective_base_debt_nad'),
      ),
      effectiveQuoteDebtNad: stringValue(
        field(health, 'effectiveQuoteDebtNad', 'effective_quote_debt_nad'),
      ),
      baseDebtHealthBps: stringValue(
        field(health, 'baseDebtHealthBps', 'base_debt_health_bps'),
      ),
      quoteDebtHealthBps: stringValue(
        field(health, 'quoteDebtHealthBps', 'quote_debt_health_bps'),
      ),
      healthSourceSlot: healthObservation.sourceSlot,
      healthObservedAt: iso(healthBlockTime),
      sourceTxSig: null,
      sourceSlot,
      observedAt: iso(sourceBlockTime),
    },
  };
}

/**
 * Persist mint decimals for the valuation views. Best effort on purpose: a
 * market read must not fail because a bookkeeping write did, and the views
 * degrade to no prices rather than wrong ones when a mint is missing.
 */
async function recordTokenMetadata(
  tokens: { mint: string; decimals: number; tokenProgram: string }[],
): Promise<void> {
  try {
    for (const token of tokens) {
      if (!Number.isInteger(token.decimals) || token.decimals < 0) continue;
      await pool.query(
        `INSERT INTO dusk_ingestion.token_metadata (mint, decimals, token_program)
         VALUES ($1, $2, $3)
         ON CONFLICT (mint) DO UPDATE
           SET decimals = EXCLUDED.decimals,
               token_program = EXCLUDED.token_program,
               updated_at = now()`,
        [token.mint, token.decimals, token.tokenProgram],
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/does not exist/i.test(message)) {
      console.warn(`Recording token metadata failed: ${message}`);
    }
  }
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
  const slot = await connection.getSlot(DUSK_DEPLOYMENT_COMMITMENT);
  // The IDL is loaded at runtime, so Anchor's account namespace is untyped
  // here; the decoded shape is validated by the read boundary downstream.
  const namespace = program.account as unknown as Record<
    string,
    {
      all(): Promise<{ publicKey: PublicKey; account: unknown }[]>;
      fetchAndContext(
        address: PublicKey,
        commitment: string,
      ): Promise<{ data: unknown; context: { slot: number } }>;
    }
  >;
  const accounts = await namespace.market.all();
  return {
    markets: accounts.map((entry) => ({
      address: entry.publicKey,
      account: entry.account,
    })),
    sourceSlot: slot,
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
