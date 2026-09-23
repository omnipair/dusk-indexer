// Backend display capture; ported from the reviewed webapp adapter.
import { BorshInstructionCoder } from '@coral-xyz/anchor';
import {
  createLeverageDelegateProgram,
  deriveReferralAccrualAddress,
  deriveReferralPartnerAddress,
} from './virtualBook/native';
import {
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  unpackAccount,
} from '@solana/spl-token';
import {
  ComputeBudgetProgram,
  PublicKey,
  SYSVAR_CLOCK_PUBKEY,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';

import { readDuskOpenEvent } from './duskEntryReceipt';
import { duskU64 } from './duskEntryReceipt';

import type { DuskOrderRow } from './duskOrderCapture';
import type { Dusk, LeveragePosition, Market } from '@omnipair/dusk-sdk';
import type {
  AccountInfo,
  SimulatedTransactionResponse,
} from '@solana/web3.js';

type Entry = DuskOrderRow<'leverageEntryOrder'>;
export interface DuskEntryOrderMark {
  observedAt: number;
  slot: number;
  priceNad: bigint;
  reached: boolean;
}

/** Native quote/base execution-price rounding, applied to an actual open receipt. */
export function duskEntryExecutionPrice(
  debtAsset: number,
  notional: bigint,
  collateral: bigint,
  baseDecimals: number,
  quoteDecimals: number,
) {
  if (
    ![0, 1].includes(debtAsset) ||
    notional <= 0n ||
    collateral <= 0n ||
    [baseDecimals, quoteDecimals].some(
      (d) => !Number.isInteger(d) || d < 0 || d > 18,
    )
  )
    throw new Error('Invalid entry execution amounts or precision');
  const base = debtAsset === 0 ? notional : collateral;
  const quote = debtAsset === 0 ? collateral : notional;
  const numerator =
    quote *
    1_000_000_000n *
    10n ** BigInt(Math.max(0, baseDecimals - quoteDecimals));
  const denominator =
    base * 10n ** BigInt(Math.max(0, quoteDecimals - baseDecimals));
  const price =
    (numerator + (debtAsset === 1 ? denominator - 1n : 0n)) / denominator;
  return duskU64(price.toString());
}

/** Only decoded, same-bank evidence can supply an order's current price. */
export async function readDuskEntryOrderReceipt(
  dusk: Dusk,
  row: Entry,
  result: SimulatedTransactionResponse,
  slot: number,
  fundingVault: PublicKey,
  tokenProgram: PublicKey,
) {
  if (result.err || result.accounts?.length !== 5)
    throw new Error('Entry preview failed');
  const account = (index: number, owner: PublicKey): AccountInfo<Buffer> => {
    const raw = result.accounts![index];
    if (
      !raw ||
      raw.executable ||
      raw.owner !== owner.toBase58() ||
      raw.data.length !== 2 ||
      raw.data[1] !== 'base64' ||
      Buffer.from(raw.data[0], 'base64').toString('base64') !== raw.data[0]
    )
      throw new Error('Invalid entry preview account');
    return { ...raw, owner, data: Buffer.from(raw.data[0], 'base64') };
  };
  const delegate = createLeverageDelegateProgram({
    provider: dusk.program.provider as Parameters<
      typeof createLeverageDelegateProgram
    >[0]['provider'],
  });
  const expectedOrder = await delegate.coder.accounts.encode(
    'leverageEntryOrder',
    row.account,
  );
  if (
    !account(0, delegate.programId)
      .data.subarray(0, expectedOrder.length)
      .equals(expectedOrder)
  )
    throw new Error('Entry order changed during its preview');
  const market = dusk.program.coder.accounts.decode<Market>(
    'market',
    account(1, dusk.program.programId).data,
  );
  const position = dusk.program.coder.accounts.decode<LeveragePosition>(
    'leveragePosition',
    account(2, dusk.program.programId).data,
  );
  const escrow = unpackAccount(
    fundingVault,
    account(3, tokenProgram),
    tokenProgram,
  );
  const clock = account(
    4,
    new PublicKey('Sysvar1111111111111111111111111111111111111'),
  ).data;
  if (clock.length !== 40 || clock.readBigUInt64LE(0) !== BigInt(slot))
    throw new Error('Invalid entry preview Clock');
  const now = clock.readBigInt64LE(32);
  const order = row.account;
  const debt = order.debtAsset === 0 ? market.baseSide : market.quoteSide;
  const collateralSide =
    order.debtAsset === 0 ? market.quoteSide : market.baseSide;
  const event = readDuskOpenEvent(result, { dusk });
  const margin = duskU64(position.marginAmount.toString());
  const collateral = duskU64(position.collateralAmount.toString());
  const notional = duskU64(position.openNotional.toString());
  if (
    now <= 0n ||
    now > BigInt(order.expiryUnixTimestamp.toString()) ||
    market.version !== row.market.version ||
    market.bump !== row.market.bump ||
    !market.ylpMint.equals(row.market.ylpMint) ||
    !debt.assetMint.equals(order.debtMint) ||
    !collateralSide.assetMint.equals(order.collateralMint) ||
    market.baseSide.assetDecimals !== row.market.baseSide.assetDecimals ||
    market.quoteSide.assetDecimals !== row.market.quoteSide.assetDecimals ||
    !position.owner.equals(order.owner) ||
    !position.market.equals(order.market) ||
    !position.positionId.equals(order.positionId) ||
    position.debtAsset !== order.debtAsset ||
    position.multiplierBps.toString() !== order.multiplierBps.toString() ||
    !event.owner.equals(order.owner) ||
    !event.metadata.signer.equals(order.owner) ||
    !event.market.equals(order.market) ||
    !event.metadata.market.equals(order.market) ||
    !event.position.equals(order.position) ||
    event.metadata.slot.toString() !== String(slot) ||
    !event.debtAssetMint.equals(order.debtMint) ||
    !event.collateralAssetMint.equals(order.collateralMint) ||
    event.multiplierBps.toString() !== order.multiplierBps.toString() ||
    event.marginAmount.toString() !== margin.toString() ||
    event.collateralAmount.toString() !== collateral.toString() ||
    event.debtShares.toString() !== position.debtShares.toString() ||
    event.swap.amountIn.toString() !== notional.toString() ||
    event.swap.assetInSide !== order.debtAsset ||
    margin <= 0n ||
    margin > BigInt(order.marginAmount.toString()) ||
    collateral <= 0n ||
    collateral > BigInt(event.swap.amountOut.toString()) ||
    collateral < BigInt(order.minCollateralOut.toString()) ||
    !escrow.isInitialized ||
    escrow.isFrozen ||
    !escrow.owner.equals(new PublicKey(row.address)) ||
    !escrow.mint.equals(order.debtMint) ||
    escrow.amount < BigInt(order.executorBounty.toString())
  )
    throw new Error('Entry preview does not match the order');
  // The launch limiter forbids delegate CPI even if a direct Dusk open could
  // pass. Never turn that direct-instruction distinction into a ready order.
  const amm = market.config.amm;
  const protectedSide =
    amm.launchRateLimitAsset === 1
      ? 0
      : amm.launchRateLimitAsset === 2
        ? 1
        : -1;
  if (
    protectedSide === 1 - order.debtAsset &&
    now >= BigInt(market.config.startTime.toString()) &&
    now - BigInt(market.config.startTime.toString()) <
      BigInt(amm.launchRateLimitDurationSeconds.toString())
  )
    throw new Error('Entry delegate is restricted during this market launch');
  const priceNad = duskEntryExecutionPrice(
    order.debtAsset,
    notional,
    collateral,
    market.baseSide.assetDecimals,
    market.quoteSide.assetDecimals,
  );
  return {
    priceNad,
    reached:
      order.debtAsset === 0
        ? priceNad >= BigInt(order.limitPriceNad.toString())
        : priceNad <= BigInt(order.limitPriceNad.toString()),
  };
}

/** Read-only unsigned simulation of the delegate's exact Dusk open from escrow. */
export async function previewDuskEntryOrder(
  dusk: Dusk,
  row: Entry,
  payer: string,
  floor: number,
  signal?: AbortSignal,
): Promise<DuskEntryOrderMark | null> {
  const observedAt = Date.now();
  if (BigInt(row.account.expiryUnixTimestamp.toString()) < row.unixTimestamp)
    return null;
  const order = row.account;
  const instruction = await dusk.write.buildOpenLeverageInstruction({
    owner: row.address,
    payer,
    market: order.market,
    positionId: order.positionId,
    debtAsset: order.debtAsset === 0 ? 'base' : 'quote',
    debtMint: order.debtMint,
    collateralMint: order.collateralMint,
    marginAmount: order.marginAmount.toString(),
    multiplierBps: order.multiplierBps.toString(),
    minCollateralOut: order.minCollateralOut.toString(),
    limitPriceNad: 0,
  });
  const idl = dusk.program.idl.instructions.find(
    (i) => i.name === 'openLeverage',
  )!;
  const index = (name: string) => {
    const value = idl.accounts.findIndex((a) => a.name === name);
    if (value < 0) throw new Error('Entry preview SDK interface changed');
    return value;
  };
  const fundingVault = instruction.keys[index('ownerDebtAccount')].pubkey;
  // Derive both possible ATAs; the SDK already selected the mint's real program.
  const tokenProgram = fundingVault.equals(
    getAssociatedTokenAddressSync(
      order.debtMint,
      new PublicKey(row.address),
      true,
      TOKEN_PROGRAM_ID,
    ),
  )
    ? TOKEN_PROGRAM_ID
    : TOKEN_2022_PROGRAM_ID;
  if (
    !fundingVault.equals(
      getAssociatedTokenAddressSync(
        order.debtMint,
        new PublicKey(row.address),
        true,
        tokenProgram,
      ),
    )
  )
    throw new Error('Invalid entry escrow address');
  const keys = instruction.keys.map((key) => ({ ...key }));
  if (order.referrer) {
    const partner = deriveReferralPartnerAddress(order.referrer)[0];
    keys[index('referralPartner')].pubkey = partner;
    keys[index('referralAccrual')].pubkey = deriveReferralAccrualAddress(
      partner,
      order.market,
      order.debtMint,
    )[0];
    keys[index('referralAccrual')].isWritable = true;
  }
  const coder = new BorshInstructionCoder(dusk.program.idl);
  const decoded = coder.decode(instruction.data)?.data as {
    args: Record<string, unknown>;
  };
  const open = new TransactionInstruction({
    ...instruction,
    keys,
    data: coder.encode('openLeverage', {
      args: {
        ...decoded.args,
        positionOwner: order.owner,
        referrer: order.referrer,
      },
    }),
  });
  if (signal?.aborted) throw new Error('Entry preview cancelled');
  const tx = new VersionedTransaction(
    new TransactionMessage({
      payerKey: new PublicKey(payer),
      recentBlockhash: PublicKey.default.toBase58(),
      instructions: [
        ComputeBudgetProgram.requestHeapFrame({ bytes: 256 * 1024 }),
        ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
        open,
      ],
    }).compileToV0Message(),
  );
  const result = await dusk.program.provider.connection.simulateTransaction(
    tx,
    {
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: 'confirmed',
      minContextSlot: floor,
      innerInstructions: true,
      accounts: {
        encoding: 'base64',
        addresses: [
          row.address,
          order.market.toBase58(),
          order.position.toBase58(),
          fundingVault.toBase58(),
          SYSVAR_CLOCK_PUBKEY.toBase58(),
        ],
      },
    },
  );
  if (
    !Number.isSafeInteger(result.context.slot) ||
    result.context.slot < floor ||
    signal?.aborted
  )
    throw new Error('Entry preview is behind its order');
  if (result.value.err) return null;
  return {
    observedAt,
    slot: result.context.slot,
    ...(await readDuskEntryOrderReceipt(
      dusk,
      row,
      result.value,
      result.context.slot,
      fundingVault,
      tokenProgram,
    )),
  };
}
