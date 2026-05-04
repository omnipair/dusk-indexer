import { Request, Response } from 'express';
import pool from '../config/database';
import { cache } from '../utils/cache';
import {
  isValidAddress,
  initializePairStateService,
} from './helpers/controllerBase';

/**
 * GeckoTerminal Integration API (v0.1).
 *
 * Implements the four endpoints required by the GeckoTerminal indexer:
 *   GET /latest-block
 *   GET /asset?id=<mint>
 *   GET /pair?id=<pair_address>
 *   GET /events?fromBlock=<slot>&toBlock=<slot>
 *
 * Solana slots are used as block numbers. The endpoint contract is the public
 * spec: https://docs.google.com/document/d/1ufjAJUa6rGO9PBGJGwfBMn-XMk9NE0ow3_iMYrS3drk
 */

const DEX_KEY = 'omnipair';

const LATEST_BLOCK_TTL_MS = 1_000;
const ASSET_TTL_MS = 5 * 60 * 1000;
const PAIR_TTL_MS = 60 * 60 * 1000;
const EVENTS_TTL_MS = 1_000;

const MAX_BLOCK_RANGE = 50_000;

type Block = {
  blockNumber: number;
  blockTimestamp: number;
};

function toUnixSeconds(ts: Date | string | number): number {
  if (ts instanceof Date) return Math.floor(ts.getTime() / 1000);
  if (typeof ts === 'number') return Math.floor(ts);
  return Math.floor(new Date(ts).getTime() / 1000);
}

function readStringQueryParam(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toFiniteNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'number' ? value : parseFloat(String(value));
  return Number.isFinite(n) ? n : null;
}

function decimalize(raw: unknown, decimals: number): string {
  if (raw === null || raw === undefined) return '0';
  const asString = typeof raw === 'string' ? raw : String(raw);
  if (asString === '0' || asString === '') return '0';
  const n = parseFloat(asString);
  if (!Number.isFinite(n)) return '0';
  return (n / Math.pow(10, decimals)).toString();
}

async function getTokenDecimalsByMint(mint: string): Promise<number> {
  return cache.getOrSet(`gecko:token_decimals:${mint}`, 24 * 60 * 60 * 1000, async () => {
    const service = await initializePairStateService();
    const meta = await service.getTokenMetadata(mint);
    return meta.decimals ?? 6;
  });
}

async function getPairDecimals(
  pairAddress: string
): Promise<{ token0: string; token1: string; decimals0: number; decimals1: number } | null> {
  return cache.getOrSet(`gecko:pair_decimals:${pairAddress}`, 24 * 60 * 60 * 1000, async () => {
    const r = await pool.query(
      `SELECT token0, token1 FROM pools WHERE pair_address = $1 LIMIT 1`,
      [pairAddress]
    );
    const row = r.rows[0];
    if (!row) return null;
    const [decimals0, decimals1] = await Promise.all([
      getTokenDecimalsByMint(row.token0),
      getTokenDecimalsByMint(row.token1),
    ]);
    return { token0: row.token0, token1: row.token1, decimals0, decimals1 };
  });
}

export class GeckoTerminalController {
  /**
   * GET /latest-block
   *
   * Returns the latest slot for which event data has been indexed. We take the
   * MAX(slot) across the event tables that the /events endpoint reads from so
   * the indexer never asks for events past the persisted frontier.
   */
  static async getLatestBlock(_req: Request, res: Response): Promise<void> {
    try {
      const block = await cache.getOrSet<Block | null>(
        'gecko:latest_block',
        LATEST_BLOCK_TTL_MS,
        async () => {
          const r = await pool.query(`
            WITH latest AS (
              SELECT slot, "timestamp" FROM swaps
              WHERE slot IS NOT NULL
              ORDER BY slot DESC
              LIMIT 1
            ), latest_liq AS (
              SELECT slot, "timestamp" FROM adjust_liquidity
              WHERE slot IS NOT NULL
              ORDER BY slot DESC
              LIMIT 1
            )
            SELECT slot, "timestamp" FROM (
              SELECT * FROM latest
              UNION ALL
              SELECT * FROM latest_liq
            ) u
            ORDER BY slot DESC NULLS LAST
            LIMIT 1
          `);
          const row = r.rows[0];
          if (!row || row.slot === null) return null;
          return {
            blockNumber: Number(row.slot),
            blockTimestamp: toUnixSeconds(row.timestamp),
          };
        }
      );

      if (!block) {
        res.status(503).json({ error: 'No indexed events available yet' });
        return;
      }

      res.json({ block });
    } catch (e) {
      console.error('gecko latest-block:', e);
      res.status(500).json({ error: 'Failed to fetch latest block' });
    }
  }

  /**
   * GET /asset?id=<mint>
   *
   * Returns metadata for an SPL token. We pull on-chain name/symbol/decimals
   * via the Metaplex metadata program (already used by PairStateService) and
   * include the live mint supply when available. coinGeckoId is omitted - we
   * only have a CMC unified id mapping today.
   */
  static async getAsset(req: Request, res: Response): Promise<void> {
    const id = readStringQueryParam(req.query.id);
    if (!id || !isValidAddress(id)) {
      res.status(400).json({ error: 'Query param "id" must be a valid mint address' });
      return;
    }

    try {
      const asset = await cache.getOrSet(`gecko:asset:${id}`, ASSET_TTL_MS, async () => {
        const service = await initializePairStateService();
        const [meta, supply] = await Promise.all([
          service.getTokenMetadata(id),
          service.getMintSupply(id),
        ]);

        const decimals = meta.decimals ?? 6;
        const out: Record<string, unknown> = {
          id,
          name: meta.name || meta.symbol || id,
          symbol: meta.symbol || 'UNKNOWN',
          decimals,
        };

        if (supply !== null) {
          out.totalSupply = (Number(supply) / Math.pow(10, decimals)).toString();
        }

        return out;
      });

      res.json({ asset });
    } catch (e) {
      console.error('gecko asset:', e);
      res.status(500).json({ error: 'Failed to fetch asset' });
    }
  }

  /**
   * GET /pair?id=<pair_address>
   *
   * Returns immutable pair metadata. createdAt* fields fall back to the pair's
   * earliest indexed event (per the GTI FAQ: "you can set createdAtBlockTimestamp
   * to be equal to the pool's first swap timestamp").
   */
  static async getPair(req: Request, res: Response): Promise<void> {
    const id = readStringQueryParam(req.query.id);
    if (!id || !isValidAddress(id)) {
      res.status(400).json({ error: 'Query param "id" must be a valid pair address' });
      return;
    }

    try {
      const pairData = await cache.getOrSet(`gecko:pair:${id}`, PAIR_TTL_MS, async () => {
        const meta = await pool.query(
          `SELECT pair_address, token0, token1, swap_fee_bps, lp_mint, version
           FROM pools
           WHERE pair_address = $1
           LIMIT 1`,
          [id]
        );
        const row = meta.rows[0];
        if (!row) return null;

        const earliest = await pool.query(
          `
          SELECT slot, "timestamp", tx_sig
          FROM (
            SELECT slot, "timestamp", tx_sig FROM swaps WHERE pair = $1
            UNION ALL
            SELECT slot, "timestamp", tx_sig FROM adjust_liquidity WHERE pair = $1
          ) u
          WHERE slot IS NOT NULL
          ORDER BY slot ASC, "timestamp" ASC
          LIMIT 1
          `,
          [id]
        );
        const first = earliest.rows[0];

        const pair: Record<string, unknown> = {
          id: row.pair_address,
          dexKey: DEX_KEY,
          asset0Id: row.token0,
          asset1Id: row.token1,
        };

        if (first) {
          pair.createdAtBlockNumber = Number(first.slot);
          pair.createdAtBlockTimestamp = toUnixSeconds(first.timestamp);
          pair.createdAtTxnId = first.tx_sig ?? undefined;
        }

        if (row.swap_fee_bps !== null && row.swap_fee_bps !== undefined) {
          const fee = toFiniteNumber(row.swap_fee_bps);
          if (fee !== null) pair.feeBps = fee;
        }

        const metadata: Record<string, unknown> = {};
        if (row.lp_mint) metadata.lpMint = row.lp_mint;
        if (row.version !== null && row.version !== undefined) {
          metadata.version = String(row.version);
        }
        if (Object.keys(metadata).length > 0) pair.metadata = metadata;

        return pair;
      });

      if (!pairData) {
        res.status(404).json({ error: 'Pair not found' });
        return;
      }

      res.json({ pair: pairData });
    } catch (e) {
      console.error('gecko pair:', e);
      res.status(500).json({ error: 'Failed to fetch pair' });
    }
  }

  /**
   * GET /events?fromBlock=<slot>&toBlock=<slot>
   *
   * Returns swap and join/exit events whose slot is in [fromBlock, toBlock].
   *
   * For swap events, reserves come straight from the swaps table. For join /
   * exit events, the indexer doesn't persist post-event reserves, so we look
   * them up from the closest update_pair_events row in the same transaction
   * (which the on-chain program emits alongside every state-changing call) and
   * apply the join/exit delta.
   *
   * txnIndex / eventIndex are derived deterministically from the block + tx so
   * the (txnIndex, eventIndex) pair is unique per block, as required by the
   * spec.
   */
  static async getEvents(req: Request, res: Response): Promise<void> {
    const fromBlockRaw = readStringQueryParam(req.query.fromBlock);
    const toBlockRaw = readStringQueryParam(req.query.toBlock);
    const fromBlock = fromBlockRaw !== null ? Number(fromBlockRaw) : NaN;
    const toBlock = toBlockRaw !== null ? Number(toBlockRaw) : NaN;

    if (!Number.isInteger(fromBlock) || !Number.isInteger(toBlock)) {
      res.status(400).json({ error: 'fromBlock and toBlock are required integers' });
      return;
    }
    if (fromBlock < 0 || toBlock < 0 || fromBlock > toBlock) {
      res.status(400).json({ error: 'Invalid block range: require 0 <= fromBlock <= toBlock' });
      return;
    }
    if (toBlock - fromBlock > MAX_BLOCK_RANGE) {
      res.status(400).json({
        error: `Block range too large; max ${MAX_BLOCK_RANGE} slots per request`,
      });
      return;
    }

    try {
      const events = await cache.getOrSet(
        `gecko:events:${fromBlock}:${toBlock}`,
        EVENTS_TTL_MS,
        () => GeckoTerminalController.fetchEvents(fromBlock, toBlock)
      );
      res.json({ events });
    } catch (e) {
      console.error('gecko events:', e);
      res.status(500).json({ error: 'Failed to fetch events' });
    }
  }

  private static async fetchEvents(fromBlock: number, toBlock: number) {
    const result = await pool.query(
      `
      WITH all_events AS (
        SELECT
          'swap'::text                  AS kind,
          s.slot::bigint                AS block_number,
          s.timestamp                   AS block_timestamp,
          s.tx_sig                      AS tx_sig,
          s.pair                        AS pair,
          s.user_address                AS maker,
          s.is_token0_in                AS is_token0_in,
          s.amount_in::text             AS amount_in,
          s.amount_out::text            AS amount_out,
          s.reserve0::text              AS reserve0,
          s.reserve1::text              AS reserve1,
          s.fee_paid0::text             AS fee_paid0,
          s.fee_paid1::text             AS fee_paid1,
          NULL::text                    AS liq_event_type,
          NULL::text                    AS amount0,
          NULL::text                    AS amount1,
          s.id                          AS src_id,
          1                             AS kind_order
        FROM swaps s
        WHERE s.slot BETWEEN $1 AND $2

        UNION ALL

        SELECT
          'liquidity'::text                                  AS kind,
          al.slot::bigint                                    AS block_number,
          al.timestamp                                       AS block_timestamp,
          al.tx_sig                                          AS tx_sig,
          al.pair                                            AS pair,
          al.user_address                                    AS maker,
          NULL::boolean                                      AS is_token0_in,
          NULL::text                                         AS amount_in,
          NULL::text                                         AS amount_out,
          upe.reserve0_after_interest::text                  AS reserve0,
          upe.reserve1_after_interest::text                  AS reserve1,
          NULL::text                                         AS fee_paid0,
          NULL::text                                         AS fee_paid1,
          al.event_type::text                                AS liq_event_type,
          al.amount0::text                                   AS amount0,
          al.amount1::text                                   AS amount1,
          al.id                                              AS src_id,
          2                                                  AS kind_order
        FROM adjust_liquidity al
        LEFT JOIN LATERAL (
          SELECT reserve0_after_interest, reserve1_after_interest
          FROM update_pair_events upe
          WHERE upe.pair = al.pair AND upe.transaction_signature = al.tx_sig
          ORDER BY upe.id DESC
          LIMIT 1
        ) upe ON TRUE
        WHERE al.slot BETWEEN $1 AND $2
      ),
      ordered AS (
        SELECT
          *,
          DENSE_RANK() OVER (
            PARTITION BY block_number
            ORDER BY tx_sig
          ) - 1 AS txn_index,
          ROW_NUMBER() OVER (
            PARTITION BY block_number, tx_sig
            ORDER BY kind_order, src_id
          ) - 1 AS event_index
        FROM all_events
      )
      SELECT * FROM ordered
      ORDER BY block_number ASC, txn_index ASC, event_index ASC
      `,
      [fromBlock, toBlock]
    );

    if (result.rows.length === 0) return [];

    const pairAddresses = Array.from(new Set(result.rows.map((r: any) => r.pair as string)));
    const pairDecimalsList = await Promise.all(pairAddresses.map((p) => getPairDecimals(p)));
    const pairDecimalsMap = new Map<string, { decimals0: number; decimals1: number }>();
    pairAddresses.forEach((addr, i) => {
      const meta = pairDecimalsList[i];
      if (meta) pairDecimalsMap.set(addr, { decimals0: meta.decimals0, decimals1: meta.decimals1 });
    });

    const events = [];
    for (const row of result.rows) {
      const decimals = pairDecimalsMap.get(row.pair);
      if (!decimals) continue;
      const { decimals0, decimals1 } = decimals;

      const block: Block = {
        blockNumber: Number(row.block_number),
        blockTimestamp: toUnixSeconds(row.block_timestamp),
      };

      const base = {
        block,
        txnId: row.tx_sig as string,
        txnIndex: Number(row.txn_index),
        eventIndex: Number(row.event_index),
        maker: row.maker as string,
        pairId: row.pair as string,
      };

      if (row.kind === 'swap') {
        const reserves = {
          asset0: decimalize(row.reserve0, decimals0),
          asset1: decimalize(row.reserve1, decimals1),
        };

        const reserve0Num = parseFloat(reserves.asset0);
        const reserve1Num = parseFloat(reserves.asset1);
        if (!(reserve0Num > 0 && reserve1Num > 0)) continue;
        const priceNative = (reserve1Num / reserve0Num).toString();

        const swap: Record<string, unknown> = {
          ...base,
          eventType: 'swap',
          priceNative,
          reserves,
        };

        if (row.is_token0_in) {
          swap.asset0In = decimalize(row.amount_in, decimals0);
          swap.asset1Out = decimalize(row.amount_out, decimals1);
        } else {
          swap.asset1In = decimalize(row.amount_in, decimals1);
          swap.asset0Out = decimalize(row.amount_out, decimals0);
        }

        const metadata: Record<string, unknown> = {};
        if (row.fee_paid0 && row.fee_paid0 !== '0') {
          metadata[row.is_token0_in ? 'fees0In' : 'fees0Out'] = decimalize(row.fee_paid0, decimals0);
        }
        if (row.fee_paid1 && row.fee_paid1 !== '0') {
          metadata[row.is_token0_in ? 'fees1Out' : 'fees1In'] = decimalize(row.fee_paid1, decimals1);
        }
        if (Object.keys(metadata).length > 0) swap.metadata = metadata;

        events.push(swap);
        continue;
      }

      // liquidity (join/exit)
      const liqType = String(row.liq_event_type || '').toLowerCase();
      const isJoin = liqType === 'add' || liqType === 'mint';
      const eventType: 'join' | 'exit' = isJoin ? 'join' : 'exit';

      const amount0Human = decimalize(row.amount0, decimals0);
      const amount1Human = decimalize(row.amount1, decimals1);

      let reserves: { asset0: string; asset1: string } | null = null;
      const reserve0Raw = row.reserve0;
      const reserve1Raw = row.reserve1;
      if (reserve0Raw !== null && reserve1Raw !== null && reserve0Raw !== undefined && reserve1Raw !== undefined) {
        const r0 = parseFloat(reserve0Raw);
        const r1 = parseFloat(reserve1Raw);
        const a0Raw = parseFloat(row.amount0 ?? '0');
        const a1Raw = parseFloat(row.amount1 ?? '0');
        const sign = isJoin ? 1 : -1;
        const r0After = r0 + sign * a0Raw;
        const r1After = r1 + sign * a1Raw;
        if (r0After >= 0 && r1After >= 0) {
          reserves = {
            asset0: (r0After / Math.pow(10, decimals0)).toString(),
            asset1: (r1After / Math.pow(10, decimals1)).toString(),
          };
        }
      }

      // Spec requires a reserves object - if we couldn't derive it, skip the
      // event rather than emit invalid data (which would halt the indexer).
      if (!reserves) continue;

      events.push({
        ...base,
        eventType,
        amount0: amount0Human,
        amount1: amount1Human,
        reserves,
      });
    }

    return events;
  }
}
