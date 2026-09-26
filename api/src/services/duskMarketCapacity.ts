/**
 * Market capacity for the markets payload: each hLP vault's deposit admission
 * and each debt asset's borrow headroom, from the program's own previews.
 *
 * Both change without a transaction (interest accrues, the daily borrow bucket
 * decays, the funding EMA moves), so they are simulated when the market
 * snapshot is captured, at or after its bank, and cached with it. A preview
 * the program rejects leaves that capacity unavailable; it is never reported
 * as zero, and it never removes the market from the payload.
 */

import { AnchorProvider, BN, BorshCoder, Program, Wallet } from '@coral-xyz/anchor';
import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import type { RpcResponseAndContext, SimulatedTransactionResponse, SimulateTransactionConfig } from '@solana/web3.js';

import { duskApiConfig, loadPinnedProtocol } from '../config/duskProtocol';
import { duskRawIdl } from './duskMarketSimulation';

export const HLP_DEPOSIT_STATUSES = [
  'ready',
  'notStarted',
  'reduceOnly',
  'noLiquidity',
  'rebalanceRequired',
  'cashConstrained',
  'unhedgeable',
  'settlementRequired',
  'noFundingCapacity',
  'noNetDeposit',
] as const;
export type HlpDepositStatus = (typeof HLP_DEPOSIT_STATUSES)[number];
export type MarketSide = 'base' | 'quote';

export interface HlpDepositCapacity {
  status: HlpDepositStatus;
  /** Gross wallet debit, including the current epoch's transfer fee. */
  fundingLimitGross: string;
  fundingLimitNet: string;
  sourceSlot: number;
}

/** Borrow headroom for one debt asset, quoted for one whole collateral token.
 * Cash and daily-limit headroom do not depend on the collateral amount; the
 * collateral factors and health-limited debt are for the reference amount. */
export interface BorrowHeadroom {
  collateralAsset: MarketSide;
  referenceCollateralAmount: string;
  collateralValueNad: string;
  maxDebtByHealth: string;
  maxDebtByCash: string;
  maxDebtByDailyLimit: string;
  maxDebt: string;
  maxCfBps: number;
  liquidationCfBps: number;
  sourceSlot: number;
}

export interface MarketCapacities {
  hlp: Record<MarketSide, HlpDepositCapacity | null>;
  /** Keyed by the debt asset; the collateral is the opposite side. */
  borrow: Record<MarketSide, BorrowHeadroom | null>;
}

export interface MarketCapacityInput {
  market: string;
  baseMint: string;
  quoteMint: string;
  baseDecimals: number;
  quoteDecimals: number;
  baseHlpMint: string;
  quoteHlpMint: string;
}

export interface CapacityDependencies {
  rpc: {
    simulateTransaction(
      transaction: VersionedTransaction,
      config: SimulateTransactionConfig,
    ): Promise<RpcResponseAndContext<SimulatedTransactionResponse>>;
  };
  payer: string;
}

const U64_MAX = (1n << 64n) - 1n;
const U128_MAX = (1n << 128n) - 1n;

function unsignedText(value: unknown, max: bigint): string {
  const text = String(value);
  if (!/^(0|[1-9]\d*)$/.test(text) || BigInt(text) > max) throw new Error('Invalid capacity amount');
  return text;
}

function variant(value: unknown): string {
  const keys = value && typeof value === 'object' ? Object.keys(value) : [];
  if (keys.length !== 1) throw new Error('Invalid capacity enum');
  return keys[0];
}

let program: Program | undefined;
let decoder: BorshCoder | undefined;
/** Builds instructions only; the caller's connection runs the simulation. */
function previewProgram(): Program {
  program ??= new Program(
    duskRawIdl(),
    new AnchorProvider(new Connection(duskApiConfig().rpcUrl, 'confirmed'), {} as Wallet, {
      commitment: 'confirmed',
    }),
  );
  return program;
}
/** The raw IDL's field names, as the other market captures decode them. */
function rawDecoder(): BorshCoder {
  decoder ??= new BorshCoder(duskRawIdl());
  return decoder;
}

/** One unsigned preview at or after `minSlot`. A program rejection is `null`;
 * transport failures and malformed return data throw. */
export async function simulateCapacityPreview(
  dependencies: CapacityDependencies,
  instruction: TransactionInstruction,
  minSlot: number,
): Promise<{ slot: number; data: Buffer } | null> {
  const pin = loadPinnedProtocol();
  const transaction = new VersionedTransaction(
    new TransactionMessage({
      payerKey: new PublicKey(dependencies.payer),
      recentBlockhash: PublicKey.default.toBase58(),
      instructions: [
        ComputeBudgetProgram.requestHeapFrame({ bytes: 256 * 1024 }),
        ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
        instruction,
      ],
    }).compileToV0Message(),
  );
  const result = await dependencies.rpc.simulateTransaction(transaction, {
    commitment: 'confirmed',
    minContextSlot: minSlot,
    replaceRecentBlockhash: true,
    sigVerify: false,
  });
  const slot = result.context.slot;
  if (!Number.isSafeInteger(slot) || slot < minSlot) throw new Error('Capacity preview is behind the market snapshot');
  if (result.value.err) return null;
  const returned = result.value.returnData;
  if (
    !returned ||
    returned.programId !== pin.dusk.programId ||
    returned.data.length !== 2 ||
    returned.data[1] !== 'base64' ||
    Buffer.from(returned.data[0], 'base64').toString('base64') !== returned.data[0]
  )
    throw new Error('Capacity preview returned no program data');
  return { slot, data: Buffer.from(returned.data[0], 'base64') };
}

/** Decode and check one hLP deposit admission against its request. */
export function parseHlpDepositCapacity(
  decoded: Record<string, unknown>,
  expected: { market: string; hlpMint: string; side: MarketSide; slot: number },
): HlpDepositCapacity {
  const status = variant(decoded.status);
  const normalized = (status.charAt(0).toLowerCase() + status.slice(1)) as HlpDepositStatus;
  const gross = BigInt(unsignedText(decoded.funding_limit_gross, U64_MAX));
  const net = BigInt(unsignedText(decoded.funding_limit_net, U64_MAX));
  if (
    String(decoded.market) !== expected.market ||
    String(decoded.hlp_mint) !== expected.hlpMint ||
    variant(decoded.target_asset).toLowerCase() !== expected.side ||
    String(decoded.slot) !== String(expected.slot) ||
    !HLP_DEPOSIT_STATUSES.includes(normalized) ||
    gross < net ||
    (normalized === 'ready' ? gross === 0n || net === 0n : gross !== 0n || net !== 0n)
  )
    throw new Error('Invalid hLP deposit capacity preview');
  return {
    status: normalized,
    fundingLimitGross: gross.toString(),
    fundingLimitNet: net.toString(),
    sourceSlot: expected.slot,
  };
}

/** Decode and check one borrow capacity quote against its request. */
export function parseBorrowHeadroom(
  decoded: Record<string, unknown>,
  expected: { debtAsset: MarketSide; referenceCollateralAmount: bigint; slot: number },
): BorrowHeadroom {
  const collateralAsset: MarketSide = expected.debtAsset === 'base' ? 'quote' : 'base';
  const amount = (name: string) => BigInt(unsignedText(decoded[name], U64_MAX));
  const [health, cash, daily, maxDebt] = [
    amount('max_debt_by_health'),
    amount('max_debt_by_cash'),
    amount('max_debt_by_daily_limit'),
    amount('max_debt'),
  ];
  const bps = (name: string) => {
    const value = Number(decoded[name]);
    if (!Number.isSafeInteger(value) || value < 0 || value > 10_000) throw new Error('Invalid capacity factor');
    return value;
  };
  const maxCfBps = bps('max_cf_bps'),
    liquidationCfBps = bps('liquidation_cf_bps');
  const least = [health, cash, daily].reduce((low, value) => (value < low ? value : low));
  if (
    variant(decoded.debt_asset).toLowerCase() !== expected.debtAsset ||
    variant(decoded.collateral_asset).toLowerCase() !== collateralAsset ||
    amount('collateral_amount') !== expected.referenceCollateralAmount ||
    maxDebt !== least ||
    amount('projected_borrow_amount') !== maxDebt ||
    maxCfBps > liquidationCfBps
  )
    throw new Error('Invalid borrow capacity preview');
  return {
    collateralAsset,
    referenceCollateralAmount: expected.referenceCollateralAmount.toString(),
    collateralValueNad: unsignedText(decoded.collateral_value_nad, U128_MAX),
    maxDebtByHealth: health.toString(),
    maxDebtByCash: cash.toString(),
    maxDebtByDailyLimit: daily.toString(),
    maxDebt: maxDebt.toString(),
    maxCfBps,
    liquidationCfBps,
    sourceSlot: expected.slot,
  };
}

/** Each preview is independent. One failure leaves only that capacity unknown. */
export async function captureMarketCapacities(
  input: MarketCapacityInput,
  minSlot: number,
  dependencies: CapacityDependencies,
  builder: Pick<Program, 'methods'> = previewProgram(),
): Promise<MarketCapacities> {
  const pin = loadPinnedProtocol();
  const market = new PublicKey(input.market);
  const [futarchyAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from('futarchy_authority')],
    new PublicKey(pin.dusk.programId),
  );
  const sides: MarketSide[] = ['base', 'quote'];
  const hlp = await Promise.all(
    sides.map(async (side) => {
      const hlpMint = side === 'base' ? input.baseHlpMint : input.quoteHlpMint;
      const instruction = await builder.methods
        .previewHlpDepositCapacity()
        .accountsStrict({
          market,
          futarchyAuthority,
          baseMint: new PublicKey(input.baseMint),
          quoteMint: new PublicKey(input.quoteMint),
          targetHlpMint: new PublicKey(hlpMint),
        })
        .instruction();
      const preview = await simulateCapacityPreview(dependencies, instruction, minSlot);
      if (!preview) return null;
      return parseHlpDepositCapacity(
        rawDecoder().types.decode('HlpDepositCapacityPreview', preview.data),
        { market: input.market, hlpMint, side, slot: preview.slot },
      );
    }).map((read) => read.catch(() => null)),
  );
  const borrow = await Promise.all(
    sides.map(async (debtAsset) => {
      const collateralMint = debtAsset === 'base' ? input.quoteMint : input.baseMint;
      const debtMint = debtAsset === 'base' ? input.baseMint : input.quoteMint;
      const decimals = debtAsset === 'base' ? input.quoteDecimals : input.baseDecimals;
      const referenceCollateralAmount = 10n ** BigInt(decimals);
      if (referenceCollateralAmount > U64_MAX) return null;
      const instruction = await builder.methods
        .previewBorrowCapacity({
          collateralAmount: new BN(referenceCollateralAmount.toString()),
          projectedBorrowAmount: null,
        })
        .accountsStrict({
          market,
          collateralAssetMint: new PublicKey(collateralMint),
          debtAssetMint: new PublicKey(debtMint),
        })
        .instruction();
      const preview = await simulateCapacityPreview(dependencies, instruction, minSlot);
      if (!preview) return null;
      return parseBorrowHeadroom(rawDecoder().types.decode('BorrowCapacityPreview', preview.data), {
        debtAsset,
        referenceCollateralAmount,
        slot: preview.slot,
      });
    }).map((read) => read.catch(() => null)),
  );
  return {
    hlp: { base: hlp[0], quote: hlp[1] },
    borrow: { base: borrow[0], quote: borrow[1] },
  };
}
