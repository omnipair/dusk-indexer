import { minimumDuskReadSlot } from './native';
import type { DuskDeploymentEnvelope } from '../duskDeploymentService';
import type { DuskReadBoundary } from './native';
import type { Dusk } from '@omnipair/dusk-sdk';

/** The SDK owns computation; this adapter owns deployment and mutation freshness. */
export async function readDuskVirtualBook({
  dusk,
  market,
  deployment,
  boundary,
  signal,
}: {
  dusk: Dusk;
  market: string;
  deployment: DuskDeploymentEnvelope;
  boundary: Pick<DuskReadBoundary, 'assertCompatibleForRead'>;
  signal?: AbortSignal;
}) {
  if (dusk.program.programId.toBase58() !== deployment.programId)
    throw new Error('Depth SDK deployment mismatch');
  const before = await boundary.assertCompatibleForRead(deployment, signal);
  const snapshot = await dusk.get.previewVirtualBookSnapshot(market, {
    minContextSlot: Math.max(
      before.observedSlot,
      minimumDuskReadSlot(deployment),
    ),
    signal,
  });
  const after = await boundary.assertCompatibleForRead(deployment, signal);
  if (signal?.aborted || after.observedSlot < snapshot.slot)
    throw new Error('Market depth was invalidated');
  return { ...snapshot, deployment };
}
export type DuskVirtualBookSnapshot = Awaited<
  ReturnType<typeof readDuskVirtualBook>
>;
