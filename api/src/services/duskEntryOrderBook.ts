/**
 * Open leverage entry orders for one market's book: conditional taker demand,
 * kept separate from AMM depth.
 *
 * Discovery comes from the streamed delegate instructions: an order whose
 * latest create/cancel/execute instruction is its creation. Its terms come
 * from an account read at or after the book's bank, together with the Clock,
 * so an order closed or expired since its creation is dropped rather than
 * shown.
 */

import { PublicKey, SYSVAR_CLOCK_PUBKEY } from '@solana/web3.js';
import type { Pool, PoolClient } from 'pg';
import type { Dusk, LeverageDelegateProgram } from '@omnipair/dusk-sdk';

import pool from '../config/database';
import { loadPinnedProtocol } from '../config/duskProtocol';
import { assertDuskOrderIdentity } from './duskOrderCapture';
import { boundedDuskRpcRead, createLeverageDelegateProgram } from './virtualBook/native';

type EntryOrder = Awaited<ReturnType<LeverageDelegateProgram['account']['leverageEntryOrder']['all']>>[number]['account'];

/** A frame carries at most this many orders; a larger book is unavailable. */
export const MAX_BOOK_ENTRY_ORDERS = 500;
const CLOCK_OWNER = 'Sysvar1111111111111111111111111111111111111';

export interface BookEntryOrder {
  address: string;
  owner: string;
  /** 0 when the order borrows base, 1 when it borrows quote. */
  debtAsset: 0 | 1;
  marginAmount: string;
  multiplierBps: string;
  limitPriceNad: string;
  expiryUnixTimestamp: string;
}

export interface BookEntryOrders {
  sourceSlot: number;
  /** The Clock of `sourceSlot`, in unix seconds. */
  unixTimestamp: string;
  orders: BookEntryOrder[];
}

/** Orders created in this market whose latest lifecycle instruction is still
 * their creation. A superset is harmless: the account read decides. */
export async function readOpenEntryOrderAddresses(market: string, client: Pool | PoolClient = pool): Promise<string[]> {
  const pin = loadPinnedProtocol();
  const identity = [pin.cluster, pin.leverageDelegate.programId, pin.leverageDelegate.idlCanonicalSha256, pin.revision];
  const result = await client.query<{ order_address: string }>(
    `WITH created AS (
      SELECT DISTINCT order_address FROM dusk_ingestion.order_instruction_observations
      WHERE cluster=$1 AND program_id=$2 AND idl_hash=$3 AND protocol_revision=$4
        AND instruction_name='create_leverage_entry_order' AND market_address=$5
    ), latest AS (
      SELECT DISTINCT ON (o.order_address) o.order_address,o.instruction_name
      FROM dusk_ingestion.order_instruction_observations o JOIN created USING(order_address)
      WHERE o.cluster=$1 AND o.program_id=$2 AND o.idl_hash=$3 AND o.protocol_revision=$4
        AND o.instruction_name IN ('create_leverage_entry_order','cancel_leverage_entry_order','execute_leverage_entry_order')
      ORDER BY o.order_address,o.slot DESC,o.instruction_path DESC,o.observation_id DESC
    )
    SELECT order_address FROM latest WHERE instruction_name='create_leverage_entry_order'
    ORDER BY order_address LIMIT $6`,
    [...identity, market, MAX_BOOK_ENTRY_ORDERS + 1],
  );
  if (result.rows.length > MAX_BOOK_ENTRY_ORDERS) throw new Error('Market entry orders exceed the book frame limit');
  return result.rows.map((row) => row.order_address);
}

export async function captureMarketEntryOrders(
  dusk: Dusk,
  market: { address: string; baseMint: string; quoteMint: string },
  minSlot: number,
  signal?: AbortSignal,
  discover: typeof readOpenEntryOrderAddresses = readOpenEntryOrderAddresses,
): Promise<BookEntryOrders> {
  const delegate = createLeverageDelegateProgram({
    provider: dusk.program.provider as Parameters<typeof createLeverageDelegateProgram>[0]['provider'],
  });
  if (delegate.programId.toBase58() !== loadPinnedProtocol().leverageDelegate.programId)
    throw new Error('Entry order SDK deployment mismatch');
  const addresses = await discover(market.address);
  const connection = dusk.program.provider.connection;
  let floor = minSlot,
    unixTimestamp = 0n;
  const orders: BookEntryOrder[] = [];
  // Each request carries the Clock, so every order is judged at its own bank.
  // An empty book still reads the Clock, which dates the empty result.
  const batches: PublicKey[][] = [];
  for (let start = 0; start < Math.max(addresses.length, 1); start += 99)
    batches.push(addresses.slice(start, start + 99).map((address) => new PublicKey(address)));
  for (const keys of batches) {
    const response = await boundedDuskRpcRead(
      () => connection.getMultipleAccountsInfoAndContext([...keys, SYSVAR_CLOCK_PUBKEY], { commitment: 'confirmed', minContextSlot: floor }),
      signal,
    );
    const slot = response.context.slot;
    if (!Number.isSafeInteger(slot) || slot < floor || response.value.length !== keys.length + 1)
      throw new Error('Entry order read is behind the book');
    floor = slot;
    const clock = response.value[keys.length];
    if (
      !clock ||
      clock.executable ||
      clock.owner.toBase58() !== CLOCK_OWNER ||
      clock.data.length !== 40 ||
      clock.data.readBigUInt64LE(0) !== BigInt(slot)
    )
      throw new Error('Invalid entry order Clock');
    unixTimestamp = clock.data.readBigInt64LE(32);
    if (unixTimestamp <= 0n) throw new Error('Invalid entry order time');
    for (const [index, info] of response.value.slice(0, keys.length).entries()) {
      if (!info) continue; // Cancelled or executed since its creation.
      if (info.executable || !info.owner.equals(delegate.programId)) throw new Error('Invalid entry order owner');
      const account = delegate.coder.accounts.decode<EntryOrder>('leverageEntryOrder', info.data);
      assertDuskOrderIdentity('leverageEntryOrder', keys[index], account, account.owner.toBase58(), delegate.programId);
      const [debtMint, collateralMint] =
        account.debtAsset === 0 ? [market.baseMint, market.quoteMint] : [market.quoteMint, market.baseMint];
      if (
        account.market.toBase58() !== market.address ||
        account.owner.equals(PublicKey.default) ||
        account.debtMint.toBase58() !== debtMint ||
        account.collateralMint.toBase58() !== collateralMint
      )
        throw new Error('Entry order belongs to another market or token pair');
      if (BigInt(account.expiryUnixTimestamp.toString()) < unixTimestamp) continue;
      orders.push({
        address: keys[index].toBase58(),
        owner: account.owner.toBase58(),
        debtAsset: account.debtAsset as 0 | 1,
        marginAmount: account.marginAmount.toString(),
        multiplierBps: account.multiplierBps.toString(),
        limitPriceNad: account.limitPriceNad.toString(),
        expiryUnixTimestamp: account.expiryUnixTimestamp.toString(),
      });
    }
  }
  signal?.throwIfAborted();
  return { sourceSlot: floor, unixTimestamp: unixTimestamp.toString(), orders };
}
