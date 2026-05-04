import { Request, Response } from 'express';
import pool from '../config/database';
import { cache } from '../utils/cache';
import { PoolController } from './poolController';
import { isValidAddress } from './helpers/controllerBase';
import { CMC_UNIFIED_CRYPTOASSET_ID_BY_MINT } from '../config/cmcUnifiedCryptoassetIds';

const CACHE_TTL_MS = 60_000;

/** CMC API: pair id is base_mint_quote_mint with underscore (no concatenation). */
export function tradingPairId(token0Mint: string, token1Mint: string): string {
  return `${token0Mint}_${token1Mint}`;
}

export function parseTradingPair(marketPair: string): { token0: string; token1: string } | null {
  if (!marketPair || typeof marketPair !== 'string') return null;
  const idx = marketPair.indexOf('_');
  if (idx <= 0 || idx === marketPair.length - 1) return null;
  const a = marketPair.slice(0, idx);
  const b = marketPair.slice(idx + 1);
  if (!isValidAddress(a) || !isValidAddress(b) || a === b) return null;
  return { token0: a, token1: b };
}

async function resolvePoolRowForMints(
  token0: string,
  token1: string
): Promise<{ pair_address: string; token0: string; token1: string; swap_fee_bps: number | null } | null> {
  const r = await pool.query(
    `
    SELECT pair_address, token0, token1, swap_fee_bps
    FROM pools
    WHERE visible = TRUE AND (
      (token0 = $1 AND token1 = $2) OR (token0 = $2 AND token1 = $1)
    )
    LIMIT 1
  `,
    [token0, token1]
  );
  return r.rows[0] ?? null;
}

export class CmcApiController {
  /** C0: factory / program id for the protocol (Solana program address). */
  static getFactory(_req: Request, res: Response): void {
    const id = process.env.OMNIPAIR_PROGRAM_ID;
    if (!id) {
      res.status(503).json({ error: 'OMNIPAIR_PROGRAM_ID is not configured' });
      return;
    }
    res.json({ factory: id, network: 'solana' });
  }

  /** Summary: array of all markets. */
  static async getSummary(_req: Request, res: Response): Promise<void> {
    try {
      const body = await cache.getOrSet(
        'cmc:api:summary',
        CACHE_TTL_MS,
        async () => {
          const allPools = await PoolController.fetchAllPools(false);
          const [highLowResult, openPricesResult] = await Promise.all([
            pool.query(`
              SELECT
                pair,
                MAX(reserve1::numeric / NULLIF(reserve0::numeric, 0)) AS high_raw,
                MIN(reserve1::numeric / NULLIF(reserve0::numeric, 0)) AS low_raw
              FROM swaps
              WHERE timestamp > now() - interval '24 hours'
                AND reserve0 > 0 AND reserve1 > 0
              GROUP BY pair
            `),
            pool.query(`
              SELECT DISTINCT ON (pair)
                pair,
                reserve1::numeric / NULLIF(reserve0::numeric, 0) AS open_raw,
                "timestamp"
              FROM swaps
              WHERE timestamp > now() - interval '24 hours'
                AND reserve0 > 0 AND reserve1 > 0
              ORDER BY pair, "timestamp" ASC
            `),
          ]);

          const highLowMap = new Map<string, { highRaw: number; lowRaw: number }>();
          for (const row of highLowResult.rows) {
            highLowMap.set(row.pair, {
              highRaw: parseFloat(row.high_raw),
              lowRaw: parseFloat(row.low_raw),
            });
          }
          const openMap = new Map<string, number>();
          for (const row of openPricesResult.rows) {
            openMap.set(row.pair, parseFloat(row.open_raw));
          }

          const out: Record<string, unknown>[] = [];

          for (const p of allPools) {
            const pairAddr = p.pair_address;
            const d0 = p.token0.decimals || 6;
            const d1 = p.token1.decimals || 6;
            const reserve0 = parseFloat(p.reserves.token0) / Math.pow(10, d0);
            const reserve1 = parseFloat(p.reserves.token1) / Math.pow(10, d1);
            if (!(reserve0 > 0 && reserve1 > 0)) continue;

            const lastPrice = reserve1 / reserve0;
            const feeBps = parseFloat(p.swap_fee_bps) || 0;
            const feeM = feeBps / 10000;
            const highestBid = lastPrice * (1 - feeM);
            const lowestAsk = lastPrice * (1 + feeM);

            const decimalAdjustment = Math.pow(10, d0 - d1);
            const hl = highLowMap.get(pairAddr);
            const high = hl ? hl.highRaw * decimalAdjustment : lastPrice;
            const low = hl ? hl.lowRaw * decimalAdjustment : lastPrice;

            const openRaw = openMap.get(pairAddr);
            const openPx = openRaw != null ? openRaw * decimalAdjustment : lastPrice;
            const priceChangePct =
              openPx > 0 ? ((lastPrice - openPx) / openPx) * 100 : 0;

            const baseVolume =
              parseFloat(p.volume_24h?.volume0 || '0') / Math.pow(10, d0);
            const quoteVolume =
              parseFloat(p.volume_24h?.volume1 || '0') / Math.pow(10, d1);

            out.push({
              trading_pairs: tradingPairId(p.token0.address, p.token1.address),
              base_currency: p.token0.symbol,
              quote_currency: p.token1.symbol,
              last_price: lastPrice,
              lowest_ask: lowestAsk,
              highest_bid: highestBid,
              base_volume: baseVolume,
              quote_volume: quoteVolume,
              price_change_percent_24h: priceChangePct,
              highest_price_24h: high,
              lowest_price_24h: low,
            });
          }

          return out;
        }
      );

      res.json(body);
    } catch (e) {
      console.error('cmc api summary:', e);
      res.status(500).json({ error: 'Failed to fetch summary' });
    }
  }

  /** Assets: map mint -> metadata (UCID optional). */
  static async getAssets(_req: Request, res: Response): Promise<void> {
    try {
      const payload = await cache.getOrSet(
        'cmc:api:assets:ucid',
        CACHE_TTL_MS,
        async () => {
          const allPools = await PoolController.fetchAllPools(false);
          const assets: Record<
            string,
            {
              name: string;
              unified_cryptoasset_id: string;
              can_withdraw: string;
              can_deposit: string;
              contractAddress: string;
            }
          > = {};

          for (const p of allPools) {
            for (const t of [p.token0, p.token1]) {
              const mint = t.address;
              if (assets[mint]) continue;
              const ucid = CMC_UNIFIED_CRYPTOASSET_ID_BY_MINT[mint] ?? '';
              assets[mint] = {
                name: t.name || t.symbol || mint,
                unified_cryptoasset_id: ucid,
                can_withdraw: 'true',
                can_deposit: 'true',
                contractAddress: mint,
              };
            }
          }
          return assets;
        }
      );
      res.json(payload);
    } catch (e) {
      console.error('cmc api assets:', e);
      res.status(500).json({ error: 'Failed to fetch assets' });
    }
  }

  /** Ticker: object keyed by trading_pair. */
  static async getTicker(_req: Request, res: Response): Promise<void> {
    try {
      const payload = await cache.getOrSet(
        'cmc:api:ticker:ucid',
        CACHE_TTL_MS,
        async () => {
          const allPools = await PoolController.fetchAllPools(false);

          const out: Record<
            string,
            {
              base_id: string;
              quote_id: string;
              last_price: string;
              base_volume: string;
              quote_volume: string;
              isFrozen: string;
            }
          > = {};

          for (const p of allPools) {
            const d0 = p.token0.decimals || 6;
            const d1 = p.token1.decimals || 6;
            const reserve0 = parseFloat(p.reserves.token0) / Math.pow(10, d0);
            const reserve1 = parseFloat(p.reserves.token1) / Math.pow(10, d1);
            if (!(reserve0 > 0 && reserve1 > 0)) continue;

            const lastPrice = reserve1 / reserve0;
            const baseVolume = parseFloat(p.volume_24h?.volume0 || '0') / Math.pow(10, d0);
            const quoteVolume = parseFloat(p.volume_24h?.volume1 || '0') / Math.pow(10, d1);

            const key = tradingPairId(p.token0.address, p.token1.address);
            out[key] = {
              base_id: CMC_UNIFIED_CRYPTOASSET_ID_BY_MINT[p.token0.address] ?? '',
              quote_id: CMC_UNIFIED_CRYPTOASSET_ID_BY_MINT[p.token1.address] ?? '',
              last_price: lastPrice.toString(),
              base_volume: baseVolume.toString(),
              quote_volume: quoteVolume.toString(),
              isFrozen: '0',
            };
          }

          return out;
        }
      );
      res.json(payload);
    } catch (e) {
      console.error('cmc api ticker:', e);
      res.status(500).json({ error: 'Failed to fetch ticker' });
    }
  }

  /** Full 24h trades for market (no pagination). */
  static async getTrades(req: Request, res: Response): Promise<void> {
    try {
      const raw = (req.params.market_pair as string) || (req.query.market_pair as string);
      const parsed = parseTradingPair(raw);
      if (!parsed) {
        res.status(400).json({
          error: 'Invalid market_pair. Use baseMint_quoteMint (underscore-separated Solana mints).',
        });
        return;
      }

      const prow = await resolvePoolRowForMints(parsed.token0, parsed.token1);
      if (!prow) {
        res.status(404).json({ error: 'Pool not found for mint pair' });
        return;
      }

      const allPools = await PoolController.fetchAllPools(false);
      const enriched = allPools.find((x) => x.pair_address === prow.pair_address);
      if (!enriched) {
        res.status(404).json({ error: 'Pool data unavailable' });
        return;
      }
      const d0 = enriched.token0.decimals ?? 6;
      const d1 = enriched.token1.decimals ?? 6;

      const cacheKey = `cmc:api:trades24:${prow.pair_address}`;
      const trades = await cache.getOrSet(cacheKey, 60_000, async () => {
        const r = await pool.query(
          `
          SELECT id, is_token0_in, amount_in, amount_out, "timestamp"
          FROM swaps
          WHERE pair = $1 AND "timestamp" > now() - interval '24 hours'
          ORDER BY "timestamp" DESC, id DESC
        `,
          [prow.pair_address]
        );

        return r.rows.map((row) => {
          const amountIn = parseFloat(row.amount_in);
          const amountOut = parseFloat(row.amount_out);
          const humanIn = amountIn / Math.pow(10, row.is_token0_in ? d0 : d1);
          const humanOut = amountOut / Math.pow(10, row.is_token0_in ? d1 : d0);

          let baseVol: number;
          let quoteVol: number;
          let price: number;
          if (row.is_token0_in) {
            baseVol = humanIn;
            quoteVol = humanOut;
            price = quoteVol / baseVol;
          } else {
            quoteVol = humanIn;
            baseVol = humanOut;
            price = quoteVol / baseVol;
          }

          const side: 'buy' | 'sell' = row.is_token0_in ? 'sell' : 'buy';

          return {
            trade_id: row.id as number,
            price: price.toString(),
            base_volume: baseVol.toString(),
            quote_volume: quoteVol.toString(),
            timestamp: String(new Date(row.timestamp).getTime()),
            type: side,
          };
        });
      });

      res.json(trades);
    } catch (e) {
      console.error('cmc api trades:', e);
      res.status(500).json({ error: 'Failed to fetch trades' });
    }
  }
}
