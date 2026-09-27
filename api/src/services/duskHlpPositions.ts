/**
 * An owner's hLP positions per vault for the wallet payload: the shares the
 * wallet holds, the shares escrowed by its open stop orders, and the native
 * withdrawal price for their total.
 *
 * Holdings come from the streamed LP balances and the open orders from the
 * wallet's order capture. The withdrawal price changes without a transaction
 * (funding accrues, reserves move), so it is the program's own
 * `preview_hlp_order_trigger` for the total, simulated when the wallet is
 * captured.
 */

import { PublicKey } from '@solana/web3.js';
import type { Pool, PoolClient } from 'pg';
import type { Dusk } from '@omnipair/dusk-sdk';

import pool from '../config/database';
import { loadPinnedProtocol } from '../config/duskProtocol';
import { readStreamCursor } from './duskHistoryCoverage';
import type { DuskOrderRow } from './duskOrderCapture';
import { previewDuskHlpOrderTrigger } from './duskOrderTrigger';

export interface StreamedHlpBalance {
  market: string;
  side: 'base' | 'quote';
  hlpMint: string;
  amount: string;
}

export interface StreamedLpBalance {
  market: string;
  kind: 'ylp' | 'base_hlp' | 'quote_hlp';
  lpMint: string;
  amount: string;
}

export interface HlpPosition {
  market: string;
  side: 'base' | 'quote';
  hlpMint: string;
  /** Streamed wallet balance the withdrawal price was quoted for. */
  walletBalance: string;
  /** Shares escrowed by open stop orders; they still belong to the owner. */
  protectedBalance: string;
  hasStopLoss: boolean;
  hasStopRate: boolean;
  /** Native withdrawal price per share for the total, before transfer fees;
   * null when nothing is held or the program rejects the preview. */
  principalNavPerTokenNad: string | null;
  sourceSlot: number;
}

const U64_MAX = (1n << 64n) - 1n;

/** The owner's non-zero LP balances from streamed mints, burns and hook
 * transfers. The stream's slot is read after them and covers them. */
export async function readStreamedHlpBalances(
  owner: string,
  client: Pool | PoolClient = pool,
): Promise<{ balances: StreamedHlpBalance[]; lpBalances: StreamedLpBalance[]; sourceSlot: number }> {
  const pin = loadPinnedProtocol();
  const result = await client.query<{ market: string; kind: string; lp_mint: string; amount: string }>(
    `SELECT market,kind,lp_mint,amount::text FROM dusk_ingestion.streamed_lp_balances
    WHERE cluster=$1 AND program_id=$2 AND idl_hash=$3 AND protocol_revision=$4 AND owner=$5
      AND kind IN ('ylp','base_hlp','quote_hlp') AND amount>0
    ORDER BY market,kind`,
    [pin.cluster, pin.dusk.programId, pin.dusk.idlCanonicalSha256, pin.revision, owner],
  );
  const stream = await readStreamCursor(client);
  if (!stream) throw Object.assign(new Error('The Dusk stream has not started'), { status: 503 });
  const lpBalances = result.rows.map((row): StreamedLpBalance => {
    if (!/^[1-9]\d*$/.test(row.amount) || BigInt(row.amount) > U64_MAX) throw new Error('Invalid streamed LP balance');
    if (row.kind !== 'ylp' && row.kind !== 'base_hlp' && row.kind !== 'quote_hlp') throw new Error('Invalid streamed LP kind');
    return { market: row.market, kind: row.kind, lpMint: row.lp_mint, amount: row.amount };
  });
  return {
    balances: lpBalances.filter((row) => row.kind !== 'ylp').map((row) => ({
      market: row.market, side: row.kind === 'base_hlp' ? 'base' as const : 'quote' as const, hlpMint: row.lpMint, amount: row.amount,
    })),
    lpBalances,
    sourceSlot: Number(stream.throughSlot),
  };
}

export async function captureHlpPositions(
  dusk: Dusk,
  holdings: StreamedHlpBalance[],
  orders: DuskOrderRow<'hlpOrder'>[],
  payer: string | undefined,
  minSlot: number,
  signal?: AbortSignal,
  preview: typeof previewDuskHlpOrderTrigger = previewDuskHlpOrderTrigger,
): Promise<HlpPosition[]> {
  const positions = new Map<string, Omit<HlpPosition, 'principalNavPerTokenNad' | 'sourceSlot'>>();
  const entry = (market: string, side: 'base' | 'quote', hlpMint: string) => {
    const key = `${market}:${side}`;
    const current = positions.get(key) ?? {
      market,
      side,
      hlpMint,
      walletBalance: '0',
      protectedBalance: '0',
      hasStopLoss: false,
      hasStopRate: false,
    };
    if (current.hlpMint !== hlpMint) throw new Error('hLP vault mint changed');
    positions.set(key, current);
    return current;
  };
  for (const holding of holdings) entry(holding.market, holding.side, holding.hlpMint).walletBalance = holding.amount;
  for (const order of orders) {
    // Executed and cancelled orders stay open accounts only to settle yield.
    if (order.account.status !== 0) continue;
    const market = order.account.market.toBase58(),
      target = order.account.targetHlpMint;
    const side = order.market.baseSide.hlpMint.equals(target)
      ? 'base'
      : order.market.quoteSide.hlpMint.equals(target)
        ? 'quote'
        : null;
    if (!side) throw new Error('Unknown hLP order vault');
    const row = entry(market, side, target.toBase58());
    const escrowed = BigInt(row.protectedBalance) + BigInt(order.account.hlpAmount.toString());
    if (escrowed > U64_MAX) throw new Error('hLP escrow overflow');
    row.protectedBalance = escrowed.toString();
    row.hasStopLoss ||= order.account.kind === 1;
    row.hasStopRate ||= order.account.kind === 2;
  }
  const result: HlpPosition[] = [];
  for (const row of [...positions.values()].sort((a, b) => `${a.market}:${a.side}`.localeCompare(`${b.market}:${b.side}`))) {
    const total = BigInt(row.walletBalance) + BigInt(row.protectedBalance);
    if (total === 0n || total > U64_MAX || !payer) {
      result.push({ ...row, principalNavPerTokenNad: null, sourceSlot: minSlot });
      continue;
    }
    const quote = await preview(dusk, new PublicKey(row.market), row.side === 'base' ? 0 : 1, total, payer, minSlot, undefined, signal);
    result.push({
      ...row,
      principalNavPerTokenNad: quote.value ? quote.value.principalNavPerTokenNad.toString() : null,
      sourceSlot: quote.slot,
    });
  }
  return result;
}
