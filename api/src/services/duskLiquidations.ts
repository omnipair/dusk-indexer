/**
 * Liquidation candidates: open borrow positions with debt, discovered from
 * the streamed position snapshots and valued by the program's preview when a
 * capture runs. Captures are shared across API replicas and expire with their
 * observation. They never authorize a liquidation: the transaction builder
 * reads the position again before signing.
 */

import type { Dusk } from '@omnipair/dusk-sdk';
import type { DuskDeploymentEnvelope } from './duskDeploymentService';
import {
  captureBorrowValuation,
  readStreamedBorrowPositions,
} from './duskBorrowValuation';
import type { BorrowValuation } from './duskBorrowValuation';
import { captureWithDeadline, currentDisplayState, displayRuntime } from './duskDisplayState';
import { completeBatch } from './duskWalletSnapshot';

export const liquidationCaptureDependencies = {
  positions: readStreamedBorrowPositions,
  valuation: captureBorrowValuation,
};

export async function captureLiquidations(
  dusk: Dusk,
  deployment: DuskDeploymentEnvelope,
  signal?: AbortSignal,
  deps = liquidationCaptureDependencies,
) {
  const observedAt = Date.now();
  const payer = process.env.DUSK_PREVIEW_PAYER?.trim() || deployment.programUpgradeAuthority;
  if (!payer) throw new Error('A read-only preview payer must be configured');
  const discovery = await deps.positions({ withDebt: true });
  const floor = Math.max(deployment.sourceSlot, discovery.sourceSlot);
  const valuations = await completeBatch(
    discovery.positions,
    (position) => deps.valuation(dusk, position, floor, payer, signal),
    4,
  );
  signal?.throwIfAborted();
  if (Date.now() >= observedAt + 15_000) throw new Error('Liquidation capture expired');
  const candidates = valuations.filter(
    (row): row is BorrowValuation =>
      row.status === 'available' && (row.base.isLiquidatable || row.quote.isLiquidatable || row.auction !== null),
  );
  return {
    schemaVersion: 'dusk-liquidations.v1' as const,
    observedAt,
    expiresAt: observedAt + 15_000,
    sourceSlot: Math.max(discovery.sourceSlot, ...valuations.map((row) => row.sourceSlot)),
    discovery: { sourceSlot: discovery.sourceSlot, positions: discovery.positions.length },
    candidates,
    // A position the program refuses to preview stays visible as a count and
    // address; its terms are unknown rather than safe.
    unavailable: valuations
      .filter((row) => row.status === 'unavailable')
      .map((row) => ({ address: row.address, market: row.market, sourceSlot: row.sourceSlot })),
  };
}

export function currentLiquidations() {
  return currentDisplayState('liquidations', async (deployment) => {
    const { dusk } = await displayRuntime();
    return captureWithDeadline((signal) => captureLiquidations(dusk, deployment, signal));
  });
}
