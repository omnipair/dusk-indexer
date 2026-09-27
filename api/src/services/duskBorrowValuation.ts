/**
 * Live borrow-position values from the program's `preview_borrow_position`,
 * which accrues market interest before it reports debt, health and each debt
 * side's liquidation terms. The position account and Clock come back from the
 * same simulated bank, so auction state and its elapsed time match the debt.
 *
 * Discovery never happens here: callers pass positions found in the streamed
 * state (`streamed_borrow_positions`).
 */

import {
  ComputeBudgetProgram,
  PublicKey,
  SYSVAR_CLOCK_PUBKEY,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import type { Pool, PoolClient } from 'pg';
import type { BorrowPosition, BorrowPositionPreview, Dusk, Market } from '@omnipair/dusk-sdk';

import pool from '../config/database';
import { loadPinnedProtocol } from '../config/duskProtocol';
import { readStreamCursor } from './duskHistoryCoverage';
import {
  boundedDuskRpcRead,
  decodePreviewBorrowPositionReturnData,
  deriveBorrowPositionAddress,
} from './virtualBook/native';

export interface BorrowPositionRef {
  address: string;
  market: string;
  owner: string;
}

export interface BorrowDebtSide {
  fixedDebt: string;
  collateralAmount: string;
  collateralValueNad: string;
  healthBps: string;
  maxCfBps: number;
  liquidationCfBps: number;
  liquidationReferencePriceNad: string;
  liquidationHealthBps: string;
  isLiquidatable: boolean;
  maxRepayAmount: string;
}

export interface BorrowValuation {
  status: 'available';
  address: string;
  market: string;
  owner: string;
  positionId: string;
  baseCollateral: string;
  quoteCollateral: string;
  fixedBaseShares: string;
  fixedQuoteShares: string;
  /** Present only while a liquidation auction runs; the debt side it covers. */
  auction: { debtAsset: 'base' | 'quote'; startTime: string; startPriceNad: string; floorPriceNad: string } | null;
  /** The Clock of the simulated bank, in unix seconds. */
  unixTimestamp: string;
  sourceSlot: number;
  base: BorrowDebtSide;
  quote: BorrowDebtSide;
}

export interface UnavailableBorrowValuation {
  status: 'unavailable';
  address: string;
  market: string;
  owner: string;
  sourceSlot: number;
  reason: 'preview-rejected';
}

const CLOCK_OWNER = 'Sysvar1111111111111111111111111111111111111';

/** Open positions for one owner, or every open position with debt, from the
 * position state folded from streamed lending events. The stream's slot is
 * read after them, so it covers every event they include. */
export async function readStreamedBorrowPositions(
  selection: { owner: string } | { withDebt: true },
  client: Pool | PoolClient = pool,
): Promise<{ positions: BorrowPositionRef[]; sourceSlot: number }> {
  const pin = loadPinnedProtocol();
  const owner = 'owner' in selection ? selection.owner : null;
  const result = await client.query<{ position: string; market: string; owner: string }>(
    `SELECT position,market,owner FROM dusk_ingestion.streamed_borrow_positions
    WHERE cluster=$1 AND program_id=$2 AND idl_hash=$3 AND protocol_revision=$4 AND open
      AND ($5::text IS NULL OR owner=$5)
      AND ($5::text IS NOT NULL OR fixed_base_shares>0 OR fixed_quote_shares>0)
    ORDER BY position LIMIT 501`,
    [pin.cluster, pin.dusk.programId, pin.dusk.idlCanonicalSha256, pin.revision, owner],
  );
  if (result.rows.length > 500) throw new Error('Borrow positions exceed the bounded capture');
  const stream = await readStreamCursor(client);
  if (!stream) throw Object.assign(new Error('The Dusk stream has not started'), { status: 503 });
  return {
    positions: result.rows.map((row) => ({ address: row.position, market: row.market, owner: row.owner })),
    sourceSlot: Number(stream.throughSlot),
  };
}

function side(preview: BorrowPositionPreview['baseDebt']): BorrowDebtSide {
  return {
    fixedDebt: preview.fixedDebt.toString(),
    collateralAmount: preview.collateralAmount.toString(),
    collateralValueNad: preview.collateralValueNad.toString(),
    healthBps: preview.healthBps.toString(),
    maxCfBps: preview.maxCfBps,
    liquidationCfBps: preview.liquidationCfBps,
    liquidationReferencePriceNad: preview.liquidationReferencePriceNad.toString(),
    liquidationHealthBps: preview.liquidationHealthBps.toString(),
    isLiquidatable: preview.isLiquidatable,
    maxRepayAmount: preview.maxRepayAmount.toString(),
  };
}

/** One unsigned preview at or after `minSlot`. A program rejection is an
 * explicit unavailable row; transport and identity failures throw. */
export async function captureBorrowValuation(
  dusk: Dusk,
  position: BorrowPositionRef,
  minSlot: number,
  payer: string,
  signal?: AbortSignal,
): Promise<BorrowValuation | UnavailableBorrowValuation> {
  const programId = dusk.program.programId;
  if (programId.toBase58() !== loadPinnedProtocol().dusk.programId)
    throw new Error('Borrow valuation SDK deployment mismatch');
  const addresses = [position.market, position.address, SYSVAR_CLOCK_PUBKEY.toBase58()];
  const instruction = await dusk.program.methods
    .previewBorrowPosition()
    .accountsStrict({
      market: new PublicKey(position.market),
      borrowPosition: new PublicKey(position.address),
    })
    .instruction();
  const transaction = new VersionedTransaction(
    new TransactionMessage({
      payerKey: new PublicKey(payer),
      recentBlockhash: PublicKey.default.toBase58(),
      instructions: [
        ComputeBudgetProgram.requestHeapFrame({ bytes: 256 * 1024 }),
        ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
        instruction,
      ],
    }).compileToV0Message(),
  );
  const result = await boundedDuskRpcRead(
    () =>
      dusk.program.provider.connection.simulateTransaction(transaction, {
        commitment: 'confirmed',
        minContextSlot: minSlot,
        replaceRecentBlockhash: true,
        sigVerify: false,
        accounts: { encoding: 'base64', addresses },
      }),
    signal,
  );
  const slot = result.context.slot,
    returned = result.value.returnData;
  if (!Number.isSafeInteger(slot) || slot < minSlot) throw new Error('Borrow valuation is behind its discovery');
  if (result.value.err)
    return { status: 'unavailable', ...position, sourceSlot: slot, reason: 'preview-rejected' };
  if (
    !returned ||
    returned.programId !== programId.toBase58() ||
    returned.data[1] !== 'base64' ||
    Buffer.from(returned.data[0], 'base64').toString('base64') !== returned.data[0] ||
    result.value.accounts?.length !== addresses.length
  )
    throw new Error('Borrow valuation returned incomplete program data');
  const bytes = result.value.accounts.map((account, index) => {
    const owner = index === 2 ? CLOCK_OWNER : programId.toBase58();
    if (
      !account ||
      account.executable ||
      account.owner !== owner ||
      account.data[1] !== 'base64' ||
      Buffer.from(account.data[0], 'base64').toString('base64') !== account.data[0]
    )
      throw new Error('Borrow valuation account is incompatible');
    return Buffer.from(account.data[0], 'base64');
  });
  if (bytes[2].length !== 40 || bytes[2].readBigUInt64LE(0) !== BigInt(slot))
    throw new Error('Borrow valuation Clock bank mismatch');
  const unixTimestamp = bytes[2].readBigInt64LE(32);
  const market = dusk.program.coder.accounts.decode<Market>('market', bytes[0]);
  const account = dusk.program.coder.accounts.decode<BorrowPosition>('borrowPosition', bytes[1]);
  const preview = decodePreviewBorrowPositionReturnData(returned.data);
  const [expected, bump] = deriveBorrowPositionAddress(account.market, account.positionId);
  for (const identity of [account, preview])
    if (
      identity.owner.toBase58() !== position.owner ||
      identity.market.toBase58() !== position.market ||
      !identity.positionId.equals(account.positionId)
    )
      throw new Error('Borrow valuation identity changed');
  if (
    market.version !== 1 ||
    expected.toBase58() !== position.address ||
    account.bump !== bump ||
    unixTimestamp <= 0n ||
    ![0, 1, 255].includes(account.auctionDebtAsset) ||
    preview.baseCollateral.toString() !== account.baseCollateral.toString() ||
    preview.quoteCollateral.toString() !== account.quoteCollateral.toString()
  )
    throw new Error('Borrow valuation account state changed');
  const auction =
    account.auctionDebtAsset === 255
      ? null
      : {
          debtAsset: account.auctionDebtAsset === 0 ? ('base' as const) : ('quote' as const),
          startTime: account.auctionStartTime.toString(),
          startPriceNad: account.auctionStartPriceNad.toString(),
          floorPriceNad: account.auctionFloorPriceNad.toString(),
        };
  if (auction && (BigInt(auction.startTime) <= 0n || BigInt(auction.startTime) > unixTimestamp))
    throw new Error('Invalid borrow auction start time');
  return {
    status: 'available',
    ...position,
    positionId: account.positionId.toBase58(),
    baseCollateral: account.baseCollateral.toString(),
    quoteCollateral: account.quoteCollateral.toString(),
    fixedBaseShares: account.fixedBaseShares.toString(),
    fixedQuoteShares: account.fixedQuoteShares.toString(),
    auction,
    unixTimestamp: unixTimestamp.toString(),
    sourceSlot: slot,
    base: side(preview.baseDebt),
    quote: side(preview.quoteDebt),
  };
}
