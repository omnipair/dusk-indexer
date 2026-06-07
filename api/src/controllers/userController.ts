import { Request, Response } from 'express';
import { ApiResponse } from '../types';
import { cache } from '../utils/cache';
import { timedQuery } from '../utils/dbQuery';
import { perfMetrics } from '../utils/perfMetrics';
import { isValidAddress } from './helpers/controllerBase';

type ActivityCategory = 'swaps' | 'liquidity' | 'lending';

const DEFAULT_ACTIVITY_CATEGORIES: ActivityCategory[] = ['swaps', 'liquidity', 'lending'];

function resolveActivityCacheTtlMs(limit: number, offset: number): number {
  if (offset <= limit * 2) {
    return 20 * 1000;
  }
  if (offset <= limit * 10) {
    return 60 * 1000;
  }
  return 180 * 1000;
}

function parseCategories(rawCategories?: string): ActivityCategory[] {
  if (!rawCategories) {
    return DEFAULT_ACTIVITY_CATEGORIES;
  }

  const normalized = rawCategories
    .split(',')
    .map((category) => category.trim().toLowerCase())
    .filter((category): category is ActivityCategory =>
      category === 'swaps' || category === 'liquidity' || category === 'lending'
    );

  if (normalized.length === 0) {
    return DEFAULT_ACTIVITY_CATEGORIES;
  }

  // Preserve deterministic category order.
  return DEFAULT_ACTIVITY_CATEGORIES.filter((category) => normalized.includes(category));
}

export class UserController {
  static async getUserHistory(req: Request, res: Response): Promise<void> {
    const endpointMetric = 'users.liquidity-events';
    const endpointStartedAt = Date.now();
    try {
      const userAddress = req.params.userAddress;
      const pair = req.params.pair;
      const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 100, 1), 100);
      const offset = Math.min(Math.max(parseInt(req.query.offset as string) || 0, 0), 10000);

      if (!userAddress || !pair) {
        res.status(400).json({ success: false, error: 'Both user_address and pair are required' });
        return;
      }
      if (!isValidAddress(userAddress) || !isValidAddress(pair)) {
        res.status(400).json({ success: false, error: 'Invalid address format' });
        return;
      }

      const cacheTtlMs = resolveActivityCacheTtlMs(limit, offset);
      const cacheKey = `liquidity:user:${userAddress}:pair:${pair}:limit:${limit}:offset:${offset}`;
      const { data, cacheStatus } = await cache.getOrSetWithMeta(cacheKey, cacheTtlMs, async () => {
        const dataQuery = `
          SELECT 
            al.*,
            p.token0,
            p.token1
          FROM adjust_liquidity al
          LEFT JOIN pools p ON al.pair = p.pair_address
          WHERE al.user_address = $1 AND al.pair = $2 
          ORDER BY al.timestamp DESC, al.id DESC
          LIMIT $3 OFFSET $4
        `;
        const result = await timedQuery('users.liquidity-history', dataQuery, [userAddress, pair, limit + 1, offset]);
        const hasNext = result.rows.length > limit;
        const rows = hasNext ? result.rows.slice(0, limit) : result.rows;

        const transformedHistory = rows.map((row) => {
          const { token0, token1, ...rest } = row;
          return {
            ...rest,
            pair: {
              address: row.pair,
              token0: token0,
              token1: token1
            }
          };
        });

        return {
          userHistory: transformedHistory,
          pagination: {
            total: null,
            limit,
            offset,
            hasNext
          },
          filters: {
            userAddress,
            pair,
            sortBy: 'timestamp',
            sortOrder: 'desc'
          }
        };
      });

      perfMetrics.recordCacheLookup(endpointMetric, cacheStatus);
      res.json({ success: true, data });
    } catch (error) {
      console.error('Error fetching user history:', error);
      const response: ApiResponse = {
        success: false,
        error: 'Failed to fetch user history data'
      };
      res.status(500).json(response);
    } finally {
      perfMetrics.recordEndpointLatency(endpointMetric, Date.now() - endpointStartedAt);
    }
  }

  static async getUserLendingHistory(req: Request, res: Response): Promise<void> {
    const endpointMetric = 'users.lending-events';
    const endpointStartedAt = Date.now();
    try {
      const userAddress = req.params.userAddress;
      const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 100, 1), 100);
      const offset = Math.min(Math.max(parseInt(req.query.offset as string) || 0, 0), 10000);

      if (!userAddress || !isValidAddress(userAddress)) {
        res.status(400).json({ success: false, error: 'Valid user address is required' });
        return;
      }

      const cacheTtlMs = resolveActivityCacheTtlMs(limit, offset);
      const cacheKey = `lending:user:${userAddress}:limit:${limit}:offset:${offset}`;
      const { data, cacheStatus } = await cache.getOrSetWithMeta(cacheKey, cacheTtlMs, async () => {
      const result = await timedQuery('users.lending-history', `
        SELECT * FROM (
          SELECT 
            'collateral_adjustment' as event_type,
            id,
            pair,
            signer,
            amount0::bigint,
            amount1::bigint,
            NULL::text as position,
            NULL::text as liquidator,
            NULL::bigint as collateral0_liquidated,
            NULL::bigint as collateral1_liquidated,
            NULL::bigint as debt0_liquidated,
            NULL::bigint as debt1_liquidated,
            NULL::bigint as collateral_price,
            NULL::numeric as shortfall,
            NULL::bigint as liquidation_bonus_applied,
            NULL::numeric as k0,
            NULL::numeric as k1,
            NULL::bigint as collateral0,
            NULL::bigint as collateral1,
            NULL::bigint as debt0_shares,
            NULL::bigint as debt1_shares,
            NULL::integer as collateral0_liquidation_cf_bps,
            NULL::integer as collateral1_liquidation_cf_bps,
            NULL::integer as collateral0_max_cf_bps,
            NULL::integer as collateral1_max_cf_bps,
            transaction_signature,
            slot,
            event_timestamp
          FROM adjust_collateral_events 
          WHERE signer = $1
          
          UNION ALL
          
          SELECT 
            'debt_adjustment' as event_type,
            id,
            pair,
            signer,
            amount0::bigint,
            amount1::bigint,
            NULL::text as position,
            NULL::text as liquidator,
            NULL::bigint as collateral0_liquidated,
            NULL::bigint as collateral1_liquidated,
            NULL::bigint as debt0_liquidated,
            NULL::bigint as debt1_liquidated,
            NULL::bigint as collateral_price,
            NULL::numeric as shortfall,
            NULL::bigint as liquidation_bonus_applied,
            NULL::numeric as k0,
            NULL::numeric as k1,
            NULL::bigint as collateral0,
            NULL::bigint as collateral1,
            NULL::bigint as debt0_shares,
            NULL::bigint as debt1_shares,
            NULL::integer as collateral0_liquidation_cf_bps,
            NULL::integer as collateral1_liquidation_cf_bps,
            NULL::integer as collateral0_max_cf_bps,
            NULL::integer as collateral1_max_cf_bps,
            transaction_signature,
            slot,
            event_timestamp
          FROM adjust_debt_events 
          WHERE signer = $1
          
          UNION ALL
          
          SELECT 
            'liquidation' as event_type,
            id,
            pair,
            signer,
            NULL::bigint as amount0,
            NULL::bigint as amount1,
            position::text,
            liquidator::text,
            collateral0_liquidated::bigint,
            collateral1_liquidated::bigint,
            debt0_liquidated::bigint,
            debt1_liquidated::bigint,
            collateral_price::bigint,
            shortfall::numeric,
            liquidation_bonus_applied::bigint,
            k0::numeric,
            k1::numeric,
            NULL::bigint as collateral0,
            NULL::bigint as collateral1,
            NULL::bigint as debt0_shares,
            NULL::bigint as debt1_shares,
            NULL::integer as collateral0_liquidation_cf_bps,
            NULL::integer as collateral1_liquidation_cf_bps,
            NULL::integer as collateral0_max_cf_bps,
            NULL::integer as collateral1_max_cf_bps,
            transaction_signature,
            slot,
            event_timestamp
          FROM user_position_liquidated_events 
          WHERE signer = $1
          
          UNION ALL
          
          SELECT 
            'position_update' as event_type,
            id,
            pair,
            signer,
            NULL::bigint as amount0,
            NULL::bigint as amount1,
            position::text,
            NULL::text as liquidator,
            NULL::bigint as collateral0_liquidated,
            NULL::bigint as collateral1_liquidated,
            NULL::bigint as debt0_liquidated,
            NULL::bigint as debt1_liquidated,
            NULL::bigint as collateral_price,
            NULL::numeric as shortfall,
            NULL::bigint as liquidation_bonus_applied,
            NULL::numeric as k0,
            NULL::numeric as k1,
            collateral0::bigint,
            collateral1::bigint,
            debt0_shares::bigint,
            debt1_shares::bigint,
            collateral0_liquidation_cf_bps::integer,
            collateral1_liquidation_cf_bps::integer,
            collateral0_max_cf_bps::integer,
            collateral1_max_cf_bps::integer,
            transaction_signature,
            slot,
            event_timestamp
          FROM user_position_updated_events 
          WHERE signer = $1
        ) AS combined_events
        ORDER BY event_timestamp DESC, id DESC
        LIMIT $2 OFFSET $3
      `, [userAddress, limit + 1, offset]);

      const hasNext = result.rows.length > limit;
      const rows = hasNext ? result.rows.slice(0, limit) : result.rows;

      const lendingHistory = rows.map((row) => {
        const baseEvent = {
          id: row.id,
          event_type: row.event_type,
          pair: row.pair,
          signer: row.signer,
          transaction_signature: row.transaction_signature,
          slot: row.slot,
          event_timestamp: row.event_timestamp
        };

        switch (row.event_type) {
          case 'collateral_adjustment':
            return {
              ...baseEvent,
              amount0: row.amount0,
              amount1: row.amount1,
              description: 'Collateral adjustment'
            };

          case 'debt_adjustment':
            return {
              ...baseEvent,
              amount0: row.amount0,
              amount1: row.amount1,
              description: 'Debt adjustment'
            };

          case 'liquidation':
            return {
              ...baseEvent,
              position: row.position,
              liquidator: row.liquidator,
              collateral0_liquidated: row.collateral0_liquidated,
              collateral1_liquidated: row.collateral1_liquidated,
              debt0_liquidated: row.debt0_liquidated,
              debt1_liquidated: row.debt1_liquidated,
              collateral_price: row.collateral_price,
              shortfall: row.shortfall,
              liquidation_bonus_applied: row.liquidation_bonus_applied,
              k0: row.k0,
              k1: row.k1,
              description: 'Position liquidated'
            };

          case 'position_update':
            return {
              ...baseEvent,
              position: row.position,
              collateral0: row.collateral0,
              collateral1: row.collateral1,
              debt0_shares: row.debt0_shares,
              debt1_shares: row.debt1_shares,
              collateral0_liquidation_cf_bps: row.collateral0_liquidation_cf_bps,
              collateral1_liquidation_cf_bps: row.collateral1_liquidation_cf_bps,
              collateral0_max_cf_bps: row.collateral0_max_cf_bps,
              collateral1_max_cf_bps: row.collateral1_max_cf_bps,
              description: 'Position updated'
            };

          default:
            return baseEvent;
        }
      });

      return {
        lendingHistory,
        userAddress,
        pagination: {
          total: null,
          limit,
          offset,
          hasNext
        }
      };
      });

      perfMetrics.recordCacheLookup(endpointMetric, cacheStatus);
      res.json({ success: true, data });
    } catch (error) {
      console.error('Error fetching user lending history:', error);
      const response: ApiResponse = {
        success: false,
        error: 'Failed to fetch user lending history'
      };
      res.status(500).json(response);
    } finally {
      perfMetrics.recordEndpointLatency(endpointMetric, Date.now() - endpointStartedAt);
    }
  }

  static async getUserActivity(req: Request, res: Response): Promise<void> {
    const endpointMetric = 'users.activity';
    const endpointStartedAt = Date.now();
    try {
      const userAddress = req.params.userAddress;
      const poolAddress = req.query.poolAddress as string | undefined;
      const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 100, 1), 100);
      const offset = Math.min(Math.max(parseInt(req.query.offset as string) || 0, 0), 10000);
      const sort = (req.query.sort as string || 'recent').toLowerCase() === 'oldest' ? 'oldest' : 'recent';
      const categories = parseCategories(req.query.categories as string | undefined);

      if (!userAddress || !isValidAddress(userAddress)) {
        res.status(400).json({ success: false, error: 'Valid user address is required' });
        return;
      }

      if (poolAddress && !isValidAddress(poolAddress)) {
        res.status(400).json({ success: false, error: 'Invalid poolAddress format' });
        return;
      }

      const cacheKey = `activity:user:${userAddress}:pair:${poolAddress || 'all'}:categories:${categories.join(',')}:sort:${sort}:limit:${limit}:offset:${offset}`;
      const cacheTtlMs = resolveActivityCacheTtlMs(limit, offset);

      const { data, cacheStatus } = await cache.getOrSetWithMeta(cacheKey, cacheTtlMs, async () => {
        const orderDirection = sort === 'oldest' ? 'ASC' : 'DESC';
        const wherePool = poolAddress ? 'AND pair = $2' : '';

        let userParamIndex = 1;
        let limitParamIndex = 2;
        let offsetParamIndex = 3;
        const params: any[] = [userAddress];

        if (poolAddress) {
          params.push(poolAddress);
          userParamIndex = 1;
          limitParamIndex = 3;
          offsetParamIndex = 4;
        }

        const unions: string[] = [];
        if (categories.includes('swaps')) {
          unions.push(`
            SELECT
              'swap'::text AS activity_type,
              s.id::text AS event_id,
              s.pair AS pair,
              s."timestamp" AS event_timestamp,
              s.tx_sig AS tx_signature,
              s.user_address AS actor,
              s.amount_in::text AS amount_in,
              s.amount_out::text AS amount_out,
              s.is_token0_in AS is_token0_in,
              NULL::text AS amount0,
              NULL::text AS amount1,
              NULL::text AS liquidity,
              NULL::text AS liquidity_event_type,
              NULL::text AS lending_event_type,
              NULL::text AS position,
              NULL::text AS liquidator,
              NULL::text AS collateral0,
              NULL::text AS collateral1,
              NULL::text AS debt0_shares,
              NULL::text AS debt1_shares,
              NULL::text AS collateral0_liquidated,
              NULL::text AS collateral1_liquidated,
              NULL::text AS debt0_liquidated,
              NULL::text AS debt1_liquidated,
              NULL::text AS collateral_price,
              s.slot::text AS slot
            FROM swaps s
            WHERE s.user_address = $${userParamIndex} ${wherePool}
          `);
        }

        if (categories.includes('liquidity')) {
          unions.push(`
            SELECT
              'liquidity'::text AS activity_type,
              al.id::text AS event_id,
              al.pair AS pair,
              al."timestamp" AS event_timestamp,
              al.tx_sig AS tx_signature,
              al.user_address AS actor,
              NULL::text AS amount_in,
              NULL::text AS amount_out,
              NULL::boolean AS is_token0_in,
              al.amount0::text AS amount0,
              al.amount1::text AS amount1,
              al.liquidity::text AS liquidity,
              al.event_type::text AS liquidity_event_type,
              NULL::text AS lending_event_type,
              NULL::text AS position,
              NULL::text AS liquidator,
              NULL::text AS collateral0,
              NULL::text AS collateral1,
              NULL::text AS debt0_shares,
              NULL::text AS debt1_shares,
              NULL::text AS collateral0_liquidated,
              NULL::text AS collateral1_liquidated,
              NULL::text AS debt0_liquidated,
              NULL::text AS debt1_liquidated,
              NULL::text AS collateral_price,
              al.slot::text AS slot
            FROM adjust_liquidity al
            WHERE al.user_address = $${userParamIndex} ${wherePool}
          `);
        }

        if (categories.includes('lending')) {
          unions.push(`
            SELECT
              'lending'::text AS activity_type,
              ('collateral_adjustment:' || ace.id::text) AS event_id,
              ace.pair AS pair,
              ace.event_timestamp AS event_timestamp,
              ace.transaction_signature AS tx_signature,
              ace.signer AS actor,
              NULL::text AS amount_in,
              NULL::text AS amount_out,
              NULL::boolean AS is_token0_in,
              ace.amount0::text AS amount0,
              ace.amount1::text AS amount1,
              NULL::text AS liquidity,
              NULL::text AS liquidity_event_type,
              'collateral_adjustment'::text AS lending_event_type,
              NULL::text AS position,
              NULL::text AS liquidator,
              NULL::text AS collateral0,
              NULL::text AS collateral1,
              NULL::text AS debt0_shares,
              NULL::text AS debt1_shares,
              NULL::text AS collateral0_liquidated,
              NULL::text AS collateral1_liquidated,
              NULL::text AS debt0_liquidated,
              NULL::text AS debt1_liquidated,
              NULL::text AS collateral_price,
              ace.slot::text AS slot
            FROM adjust_collateral_events ace
            WHERE ace.signer = $${userParamIndex} ${wherePool}
            UNION ALL
            SELECT
              'lending'::text AS activity_type,
              ('debt_adjustment:' || ade.id::text) AS event_id,
              ade.pair AS pair,
              ade.event_timestamp AS event_timestamp,
              ade.transaction_signature AS tx_signature,
              ade.signer AS actor,
              NULL::text AS amount_in,
              NULL::text AS amount_out,
              NULL::boolean AS is_token0_in,
              ade.amount0::text AS amount0,
              ade.amount1::text AS amount1,
              NULL::text AS liquidity,
              NULL::text AS liquidity_event_type,
              'debt_adjustment'::text AS lending_event_type,
              NULL::text AS position,
              NULL::text AS liquidator,
              NULL::text AS collateral0,
              NULL::text AS collateral1,
              NULL::text AS debt0_shares,
              NULL::text AS debt1_shares,
              NULL::text AS collateral0_liquidated,
              NULL::text AS collateral1_liquidated,
              NULL::text AS debt0_liquidated,
              NULL::text AS debt1_liquidated,
              NULL::text AS collateral_price,
              ade.slot::text AS slot
            FROM adjust_debt_events ade
            WHERE ade.signer = $${userParamIndex} ${wherePool}
            UNION ALL
            SELECT
              'lending'::text AS activity_type,
              ('liquidation:' || uple.id::text) AS event_id,
              uple.pair AS pair,
              uple.event_timestamp AS event_timestamp,
              uple.transaction_signature AS tx_signature,
              uple.signer AS actor,
              NULL::text AS amount_in,
              NULL::text AS amount_out,
              NULL::boolean AS is_token0_in,
              NULL::text AS amount0,
              NULL::text AS amount1,
              NULL::text AS liquidity,
              NULL::text AS liquidity_event_type,
              'liquidation'::text AS lending_event_type,
              uple.position::text AS position,
              uple.liquidator::text AS liquidator,
              NULL::text AS collateral0,
              NULL::text AS collateral1,
              NULL::text AS debt0_shares,
              NULL::text AS debt1_shares,
              uple.collateral0_liquidated::text AS collateral0_liquidated,
              uple.collateral1_liquidated::text AS collateral1_liquidated,
              uple.debt0_liquidated::text AS debt0_liquidated,
              uple.debt1_liquidated::text AS debt1_liquidated,
              uple.collateral_price::text AS collateral_price,
              uple.slot::text AS slot
            FROM user_position_liquidated_events uple
            WHERE uple.signer = $${userParamIndex} ${wherePool}
            UNION ALL
            SELECT
              'lending'::text AS activity_type,
              ('position_update:' || upue.id::text) AS event_id,
              upue.pair AS pair,
              upue.event_timestamp AS event_timestamp,
              upue.transaction_signature AS tx_signature,
              upue.signer AS actor,
              NULL::text AS amount_in,
              NULL::text AS amount_out,
              NULL::boolean AS is_token0_in,
              NULL::text AS amount0,
              NULL::text AS amount1,
              NULL::text AS liquidity,
              NULL::text AS liquidity_event_type,
              'position_update'::text AS lending_event_type,
              upue.position::text AS position,
              NULL::text AS liquidator,
              upue.collateral0::text AS collateral0,
              upue.collateral1::text AS collateral1,
              upue.debt0_shares::text AS debt0_shares,
              upue.debt1_shares::text AS debt1_shares,
              NULL::text AS collateral0_liquidated,
              NULL::text AS collateral1_liquidated,
              NULL::text AS debt0_liquidated,
              NULL::text AS debt1_liquidated,
              NULL::text AS collateral_price,
              upue.slot::text AS slot
            FROM user_position_updated_events upue
            WHERE upue.signer = $${userParamIndex} ${wherePool}
          `);
        }

        if (unions.length === 0) {
          return {
            items: [],
            pagination: {
              total: null,
              limit,
              offset,
              hasNext: false
            },
            filters: {
              categories,
              poolAddress: poolAddress || null,
              sort
            }
          };
        }

        params.push(limit + 1, offset);

        const query = `
          WITH combined_events AS (
            ${unions.join('\nUNION ALL\n')}
          )
          SELECT
            ce.*,
            p.token0,
            p.token1
          FROM combined_events ce
          LEFT JOIN pools p ON ce.pair = p.pair_address
          ORDER BY ce.event_timestamp ${orderDirection}, ce.event_id ${orderDirection}
          LIMIT $${limitParamIndex} OFFSET $${offsetParamIndex}
        `;

        const result = await timedQuery('users.activity', query, params);
        const hasNext = result.rows.length > limit;
        const rows = hasNext ? result.rows.slice(0, limit) : result.rows;

        const items = rows.map((row) => ({
          type: row.activity_type,
          timestamp: row.event_timestamp,
          txSignature: row.tx_signature,
          status: null,
          pair: {
            address: row.pair,
            token0: row.token0 || null,
            token1: row.token1 || null
          },
          amounts: {
            amountIn: row.amount_in,
            amountOut: row.amount_out,
            amount0: row.amount0,
            amount1: row.amount1,
            liquidity: row.liquidity,
            collateral0: row.collateral0,
            collateral1: row.collateral1,
            debt0Shares: row.debt0_shares,
            debt1Shares: row.debt1_shares,
            collateral0Liquidated: row.collateral0_liquidated,
            collateral1Liquidated: row.collateral1_liquidated,
            debt0Liquidated: row.debt0_liquidated,
            debt1Liquidated: row.debt1_liquidated
          },
          details: {
            eventId: row.event_id,
            activityType: row.activity_type,
            liquidityEventType: row.liquidity_event_type,
            lendingEventType: row.lending_event_type,
            isToken0In: row.is_token0_in,
            collateralPrice: row.collateral_price,
            actor: row.actor,
            position: row.position,
            liquidator: row.liquidator,
            slot: row.slot
          }
        }));

        return {
          items,
          pagination: {
            total: null,
            limit,
            offset,
            hasNext
          },
          filters: {
            categories,
            poolAddress: poolAddress || null,
            sort
          }
        };
      });

      perfMetrics.recordCacheLookup(endpointMetric, cacheStatus);
      res.json({ success: true, data });
    } catch (error) {
      console.error('Error fetching user activity:', error);
      const response: ApiResponse = {
        success: false,
        error: 'Failed to fetch user activity'
      };
      res.status(500).json(response);
    } finally {
      perfMetrics.recordEndpointLatency(endpointMetric, Date.now() - endpointStartedAt);
    }
  }
}
