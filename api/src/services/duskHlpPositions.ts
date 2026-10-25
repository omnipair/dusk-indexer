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
  retired?: boolean;
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
  /** Retired receipts retain yield but have no principal backing. */
  retired?: boolean;
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
  const result = await client.query<{ market: string; kind: string; lp_mint: string; amount: string; retired: boolean }>(
    `SELECT b.market,b.kind,b.lp_mint,b.amount::text,
      b.kind<>'ylp' AND b.lp_mint<>COALESCE((
        SELECT e.payload->>'new_mint' FROM dusk_ingestion.streamed_events e
        WHERE (e.cluster,e.program_id,e.idl_hash,e.protocol_revision)=(b.cluster,b.program_id,b.idl_hash,b.protocol_revision)
          AND e.event_name='HlpCohortRotated' AND e.payload->>'market'=b.market
          AND e.payload->>'target_asset'=CASE b.kind WHEN 'base_hlp' THEN '0' ELSE '1' END
        ORDER BY e.slot DESC,e.observation_id DESC LIMIT 1),
        CASE b.kind WHEN 'base_hlp' THEN m.base_hlp_mint ELSE m.quote_hlp_mint END) AS retired
    FROM dusk_ingestion.streamed_lp_balances b
    JOIN dusk_ingestion.streamed_markets m USING(cluster,program_id,idl_hash,protocol_revision,market)
    WHERE b.cluster=$1 AND b.program_id=$2 AND b.idl_hash=$3 AND b.protocol_revision=$4 AND b.owner=$5
      AND b.kind IN ('ylp','base_hlp','quote_hlp') AND b.amount>0
    ORDER BY b.market,b.kind,b.lp_mint`,
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
    balances: result.rows.filter((row) => row.kind !== 'ylp').map((row) => ({
      market: row.market, side: row.kind === 'base_hlp' ? 'base' as const : 'quote' as const, hlpMint: row.lp_mint, amount: row.amount,
      ...(row.retired ? { retired: true } : {}),
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
  const entry = (market: string, side: 'base' | 'quote', hlpMint: string, retired = false) => {
    const key = `${market}:${side}:${hlpMint}`;
    const current = positions.get(key) ?? {
      market,
      side,
      hlpMint,
      ...(retired ? { retired: true } : {}),
      walletBalance: '0',
      protectedBalance: '0',
      hasStopLoss: false,
      hasStopRate: false,
    };
    if (current.hlpMint !== hlpMint) throw new Error('hLP vault mint changed');
    positions.set(key, current);
    return current;
  };
  for (const holding of holdings) entry(holding.market, holding.side, holding.hlpMint, holding.retired).walletBalance = holding.amount;
  for (const order of orders) {
    // Executed and cancelled orders stay open accounts only to settle yield.
    if (order.account.status !== 0) continue;
    const market = order.account.market.toBase58(),
      target = order.account.targetHlpMint;
    const side = order.retiredHlp ? (order.retiredHlp.targetAsset === 0 ? 'base' : 'quote') : order.market.baseSide.hlpMint.equals(target)
      ? 'base'
      : order.market.quoteSide.hlpMint.equals(target)
        ? 'quote'
        : null;
    if (!side) throw new Error('Unknown hLP order vault');
    const row = entry(market, side, target.toBase58(), !!order.retiredHlp);
    const escrowed = BigInt(row.protectedBalance) + BigInt(order.account.hlpAmount.toString());
    if (escrowed > U64_MAX) throw new Error('hLP escrow overflow');
    row.protectedBalance = escrowed.toString();
    row.hasStopLoss ||= order.account.kind === 1;
    row.hasStopRate ||= order.account.kind === 2;
  }
  const result: HlpPosition[] = [];
  for (const row of [...positions.values()].sort((a, b) => `${a.market}:${a.side}:${a.hlpMint}`.localeCompare(`${b.market}:${b.side}:${b.hlpMint}`))) {
    if (row.retired) {
      result.push({ ...row, principalNavPerTokenNad: '0', sourceSlot: minSlot });
      continue;
    }
    const total = BigInt(row.walletBalance) + BigInt(row.protectedBalance);
    if (total === 0n || total > U64_MAX || !payer) {
      result.push({ ...row, principalNavPerTokenNad: null, sourceSlot: minSlot });
      continue;
    }
    const quote = await preview(dusk, new PublicKey(row.market), row.side === 'base' ? 0 : 1, total, payer, minSlot, undefined, signal, new PublicKey(row.hlpMint));
    result.push({
      ...row,
      ...(quote.retired ? { retired: true } : {}),
      principalNavPerTokenNad: quote.retired ? '0' : quote.value ? quote.value.principalNavPerTokenNad.toString() : null,
      sourceSlot: quote.slot,
    });
  }
  return result;
}
