import { decodeDuskVirtualBookBatch as decodeBatch } from './native';
import { minimumDuskReadSlot } from './native';
import type { DuskReadBoundary } from './native';
import type { DuskVirtualBookSnapshot } from './virtual-book-read';
import type {
  Dusk,
  DuskVirtualBookQuotes as NativeQuotes,
  VirtualBookQuoteRequest,
} from '@omnipair/dusk-sdk';
export type {
  VirtualBookQuote,
  VirtualBookQuoteRequest,
} from '@omnipair/dusk-sdk';
export type DuskVirtualBookQuotes = NativeQuotes &
  Pick<DuskVirtualBookSnapshot, 'deployment'>;

/** Diagnostic adapter; native decoding and fee rules live only in the SDK. */
export function decodeDuskVirtualBookBatch(
  dusk: Dusk,
  snapshot: DuskVirtualBookSnapshot,
  requests: VirtualBookQuoteRequest[],
  result: Parameters<typeof decodeBatch>[3],
  floor: number,
) {
  return decodeBatch(
    dusk.program,
    { ...snapshot, programId: snapshot.deployment.programId },
    requests,
    result,
    floor,
  );
}

export async function readDuskVirtualBookQuotes({
  dusk,
  snapshot,
  boundary,
  groupingBps = 10,
  signal,
}: {
  dusk: Dusk;
  snapshot: DuskVirtualBookSnapshot;
  boundary: Pick<DuskReadBoundary, 'assertCompatibleForRead'>;
  groupingBps?: number;
  signal?: AbortSignal;
}): Promise<DuskVirtualBookQuotes> {
  const { deployment } = snapshot;
  if (dusk.program.programId.toBase58() !== deployment.programId)
    throw new Error('Depth SDK deployment mismatch');
  const before = await boundary.assertCompatibleForRead(deployment, signal);
  const quotes = await dusk.get.previewVirtualBookQuotes(
    { ...snapshot, programId: deployment.programId },
    {
      groupingBps,
      minContextSlot: Math.max(
        snapshot.slot,
        before.observedSlot,
        minimumDuskReadSlot(deployment),
      ),
      signal,
    },
  );
  const after = await boundary.assertCompatibleForRead(deployment, signal);
  if (signal?.aborted || after.observedSlot < quotes.slot)
    throw new Error('Native market depth was invalidated');
  return { ...quotes, deployment };
}
