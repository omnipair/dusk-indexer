import type { PoolClient } from 'pg';
import pool from '../config/database';
import { loadPinnedProtocol } from '../config/duskProtocol';
import { readStreamCursor } from './duskHistoryCoverage';

export interface LeverageCashFlowPosition {
  address: string; market: string; openedSlot: number;
  marginRaw: string; collateralRaw: string; debtShares: string;
}
export interface LeverageCashFlowEvent {
  eventName: string; slot: number; payload: Record<string, unknown>;
}
const U64 = (1n << 64n)-1n, U128 = (1n << 128n)-1n;
function amount(value: unknown, max = U64): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,38})$/.test(value) || BigInt(value)>max)
    throw new Error('Invalid leverage cash-flow amount');
  return BigInt(value);
}
function fields(value: unknown): Record<string,unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Missing leverage cash-flow state');
  return value as Record<string,unknown>;
}

/** Total position PnL = marked equity + owner withdrawals - contributed capital.
 * Keep the program's original entry-margin basis (credited opening margin).
 * Later updates report actual gross owner debits and net owner credits. This is
 * position PnL in debt tokens, not a wallet return including network/order fees.
 * Sums are independent of transaction arrival order. The on-chain opened slot
 * separates reused PDAs; ambiguous same-slot reuse remains explicitly unknown. */
export function foldLeverageCashFlows(owner: string, position: LeverageCashFlowPosition,
  events: LeverageCashFlowEvent[], sourceSlot: number) {
  const unavailable = () => ({address:position.address,market:position.market,openedSlot:position.openedSlot,
    sourceSlot,status:'unavailable' as const,reason:'history-unavailable' as const});
  try {
    const rows = events.filter(row => row.payload.position === position.address && row.slot>=position.openedSlot);
    const openings = rows.filter(row => row.eventName === 'LeveragePositionOpened');
    if (sourceSlot<position.openedSlot || openings.length!==1 || openings[0].slot!==position.openedSlot
      || amount(openings[0].payload.margin_amount)!==amount(position.marginRaw)) return unavailable();
    const initial = openings[0].payload;
    let contributed = amount(position.marginRaw), withdrawn = 0n;
    let lastSlot = -1, states: {collateral:bigint;shares:bigint}[] = [];
    for (const row of rows) {
      const p = row.payload, settlement = row.eventName === 'FlashLiquidationSettled' || row.eventName === 'EmergencyLiquidationSettled';
      const state = settlement ? fields(p.position_state) : p;
      if (!Number.isSafeInteger(row.slot) || p.market!==position.market || (settlement ? state.owner : p.owner)!==owner
        || row.slot>sourceSlot || settlement && (p.leverage!==true || state.closed!==false)) return unavailable();
      if (!settlement && (p.debt_asset_mint!==initial.debt_asset_mint || p.collateral_asset_mint!==initial.collateral_asset_mint)) return unavailable();
      if (row.eventName === 'LeveragePositionUpdated') {
        contributed += amount(p.owner_debit); withdrawn += amount(p.owner_credit);
      } else if (row.eventName === 'FlashLiquidationSettled') withdrawn += amount(p.owner_surplus);
      else if (row.eventName === 'EmergencyLiquidationSettled') withdrawn += amount(fields(p.quote).owner_credit);
      else if (row.eventName !== 'LeveragePositionOpened') return unavailable();
      if (contributed>U128 || withdrawn>U128) return unavailable();
      const post = { collateral:amount(state[settlement?'leverage_collateral_amount':'collateral_amount']),
        shares:amount(state[settlement?'leverage_debt_shares':'debt_shares'],U128) };
      if (row.slot>lastSlot) {lastSlot=row.slot;states=[post];}
      else if (row.slot===lastSlot) states.push(post);
    }
    if (!states.some(state => state.collateral===amount(position.collateralRaw) && state.shares===amount(position.debtShares,U128))) return unavailable();
    return {address:position.address,market:position.market,openedSlot:position.openedSlot,sourceSlot,
      status:'available' as const,basis:'entry-margin-owner-flows.v1' as const,
      contributedRaw:contributed.toString(),withdrawnRaw:withdrawn.toString()};
  } catch { return unavailable(); }
}

/** Canonical observations are read in one snapshot. A lagging stream supplies
 * no invented cost basis and does not block positions, repayment or swaps. */
export async function readLeverageCashFlows(owner: string, positions: LeverageCashFlowPosition[], minSlot: number,
  client?: PoolClient) {
  if (!positions.length) return [];
  const connection = client ?? await pool.connect();
  try {
    if (!client) await connection.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const pin = loadPinnedProtocol(), stream = await readStreamCursor(connection);
    const sourceSlot = Number(stream?.throughSlot ?? 0);
    if (!Number.isSafeInteger(sourceSlot) || sourceSlot<minSlot) {
      if (!client) await connection.query('COMMIT');
      return positions.map(p => foldLeverageCashFlows(owner,p,[],minSlot));
    }
    const rows = await connection.query<{event_key:string;event_name:string;slot:string;payload:Record<string,unknown>}>(`
      SELECT event_key,event_name,slot::text,payload FROM dusk_ingestion.streamed_events
      WHERE cluster=$1 AND program_id=$2 AND idl_hash=$3 AND protocol_revision=$4
        AND payload->>'position'=ANY($5::text[]) AND slot BETWEEN $6 AND $7
        AND event_name IN ('LeveragePositionOpened','LeveragePositionUpdated','LeveragePositionClosed',
          'LeveragePositionLiquidated','DebtFreePositionClosed','FlashLiquidationSettled','EmergencyLiquidationSettled')
      LIMIT 10001`,[pin.cluster,pin.dusk.programId,pin.dusk.idlCanonicalSha256,pin.revision,
      positions.map(p=>p.address),Math.min(...positions.map(p=>p.openedSlot)),sourceSlot]);
    const events = rows.rows.length>10000 || new Set(rows.rows.map(row=>row.event_key)).size!==rows.rows.length
      ? [] : rows.rows.map(row=>({eventName:row.event_name,slot:Number(row.slot),payload:row.payload}));
    const result = positions.map(p => foldLeverageCashFlows(owner,p,events,sourceSlot));
    if (!client) await connection.query('COMMIT');
    return result;
  } catch (error) {
    if (!client) await connection.query('ROLLBACK');
    throw error;
  } finally { if (!client) connection.release(); }
}
