import { Request, Response } from 'express';
import pool from '../config/database';
import { ApiResponse } from '../types';
import { cache } from '../utils/cache';
import { isValidAddress } from './helpers/controllerBase';

export class UserController {
  static async getUserHistory(req: Request, res: Response): Promise<void> {
    try {
      const userAddress = req.params.userAddress;
      const pair = req.params.pair;
      const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 100, 1), 100);
      const offset = Math.min(Math.max(parseInt(req.query.offset as string) || 0, 0), 10000);
      const sortBy = req.query.sortBy as string || 'timestamp';
      const sortOrder = req.query.sortOrder as string || 'desc';

      if (!userAddress || !pair) {
        res.status(400).json({ success: false, error: 'Both user_address and pair are required' });
        return;
      }
      if (!isValidAddress(userAddress) || !isValidAddress(pair)) {
        res.status(400).json({ success: false, error: 'Invalid address format' });
        return;
      }

      const allowedSortFields = ['id', 'timestamp', 'amount0', 'amount1', 'liquidity'];
      if (!allowedSortFields.includes(sortBy)) {
        const response: ApiResponse = {
          success: false,
          error: `Invalid sortBy field. Allowed fields: ${allowedSortFields.join(', ')}`
        };
        res.status(400).json(response);
        return;
      }

      if (!['asc', 'desc'].includes(sortOrder.toLowerCase())) {
        const response: ApiResponse = {
          success: false,
          error: 'Invalid sortOrder. Must be "asc" or "desc"'
        };
        res.status(400).json(response);
        return;
      }

      const cacheKey = `user_history:${userAddress}:${pair}:${sortBy}:${sortOrder}:${limit}:${offset}`;
      const data = await cache.getOrSet(cacheKey, 5 * 1000, async () => {
        const countQuery = 'SELECT COUNT(*) FROM adjust_liquidity WHERE user_address = $1 AND pair = $2';
        const countResult = await pool.query(countQuery, [userAddress, pair]);
        const totalCount = parseInt(countResult.rows[0].count);

        const dataQuery = `
          SELECT 
            al.*,
            p.token0,
            p.token1
          FROM adjust_liquidity al
          LEFT JOIN pools p ON al.pair = p.pair_address
          WHERE al.user_address = $1 AND al.pair = $2 
          ORDER BY al.${sortBy} ${sortOrder.toUpperCase()} 
          LIMIT $3 OFFSET $4
        `;
        const result = await pool.query(dataQuery, [userAddress, pair, limit, offset]);

        const transformedHistory = result.rows.map(row => {
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
            total: totalCount,
            limit,
            offset,
            hasNext: offset + limit < totalCount
          },
          filters: {
            userAddress,
            pair,
            sortBy,
            sortOrder: sortOrder.toLowerCase()
          }
        };
      });

      res.json({ success: true, data });
    } catch (error) {
      console.error('Error fetching user history:', error);
      const response: ApiResponse = {
        success: false,
        error: 'Failed to fetch user history data'
      };
      res.status(500).json(response);
    }
  }

  static async getUserLendingHistory(req: Request, res: Response): Promise<void> {
    try {
      const userAddress = req.params.userAddress;
      const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 100, 1), 100);
      const offset = Math.min(Math.max(parseInt(req.query.offset as string) || 0, 0), 10000);

      if (!userAddress || !isValidAddress(userAddress)) {
        res.status(400).json({ success: false, error: 'Valid user address is required' });
        return;
      }

      const cacheKey = `lending_history:${userAddress}:${limit}:${offset}`;
      const data = await cache.getOrSet(cacheKey, 10 * 1000, async () => {
      const countResult = await pool.query(`
        SELECT 
          (
            (SELECT COUNT(*) FROM adjust_collateral_events WHERE signer = $1) +
            (SELECT COUNT(*) FROM adjust_debt_events WHERE signer = $1) +
            (SELECT COUNT(*) FROM user_position_liquidated_events WHERE signer = $1) +
            (SELECT COUNT(*) FROM user_position_updated_events WHERE signer = $1)
          ) as total_count
      `, [userAddress]);
      const totalCount = parseInt(countResult.rows[0].total_count);

      const result = await pool.query(`
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
      `, [userAddress, limit, offset]);

      const lendingHistory = result.rows.map(row => {
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
          total: totalCount,
          limit,
          offset,
          hasNext: offset + limit < totalCount
        }
      };
      });

      res.json({ success: true, data });
    } catch (error) {
      console.error('Error fetching user lending history:', error);
      const response: ApiResponse = {
        success: false,
        error: 'Failed to fetch user lending history'
      };
      res.status(500).json(response);
    }
  }
}
