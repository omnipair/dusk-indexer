import {
  combineVirtualBookBatches,
  decodeDuskVirtualBookBatch as decodeBatch,
  minimumDuskReadSlot,
  projectDuskVirtualBookCurve,
} from './native';
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

/** BrokenInvariant means this exact cumulative input cannot execute at the
 * observed bank. Omit that level; all other simulation failures invalidate the
 * book rather than being treated as missing liquidity. */
export function unquotableAmount(error: unknown): boolean {
  if (!(error instanceof Error) || error.name !== 'DuskSimulationError')
    return false;
  const simulation = (error as Error & {
    simulation?: { value?: { err?: unknown } };
  }).simulation;
  const instruction = (simulation?.value?.err as {
    InstructionError?: unknown;
  } | null)?.InstructionError;
  return (
    Array.isArray(instruction) &&
    Number.isSafeInteger(instruction[0]) &&
    instruction[0] >= 2 &&
    instruction[1]?.Custom === 6047
  );
}

/** A rejected batch is split only to identify which exact inputs the program
 * accepts. The curve and every rendered quote still come from the SDK. */
export async function recoverExecutableVirtualBookQuotes(
  dusk: Dusk,
  snapshot: DuskVirtualBookSnapshot,
  groupingBps: number,
  curve: NonNullable<ReturnType<typeof projectDuskVirtualBookCurve>>,
  minContextSlot: number,
  signal?: AbortSignal,
): Promise<NativeQuotes> {
  const nativeSnapshot = { ...snapshot, programId: snapshot.deployment.programId };
  const requests: VirtualBookQuoteRequest[] = [];
  for (const side of ['bids', 'asks'] as const) {
    let previous = 0n;
    const decimals = side === 'bids'
      ? snapshot.account.baseSide.assetDecimals
      : snapshot.account.quoteSide.assetDecimals;
    for (const level of curve[side]) {
      const decimal = (side === 'bids' ? level.total : level.quoteTotal).toFixed(decimals);
      const [whole, fraction = ''] = decimal.split('.');
      const amount = BigInt(whole) * 10n ** BigInt(decimals) +
        BigInt(fraction.padEnd(decimals, '0') || '0');
      if (amount <= previous) continue;
      requests.push({ side, amount });
      previous = amount;
    }
  }
  type BatchResult = Awaited<ReturnType<typeof dusk.get.previewVirtualBookBatch>>;
  const batches: VirtualBookQuoteRequest[][] = [];
  for (let i = 0; i < requests.length; i += 4)
    batches.push(requests.slice(i, i + 4));
  const results = (await Promise.all(batches.map(async batch => {
    const options = { minContextSlot, signal };
    try {
      return [await dusk.get.previewVirtualBookBatch(nativeSnapshot, batch, options)];
    } catch (error) {
      if (!unquotableAmount(error)) throw error;
      const singles = await Promise.all(batch.map(async request => {
        try {
          return await dusk.get.previewVirtualBookBatch(nativeSnapshot, [request], options);
        } catch (singleError) {
          if (unquotableAmount(singleError)) return null;
          throw singleError;
        }
      }));
      return singles.filter((result): result is BatchResult => result !== null);
    }
  }))).flat();
  if (!results.some(result => result.quotes.length))
    throw new Error('No executable market depth quotes');
  return combineVirtualBookBatches(nativeSnapshot, groupingBps, curve.mid, results);
}

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
  const before = await boundary.assertCompatibleForRead(deployment, signal, snapshot.slot);
  const nativeSnapshot = { ...snapshot, programId: deployment.programId };
  const minContextSlot = Math.max(
    snapshot.slot,
    before.observedSlot,
    minimumDuskReadSlot(deployment),
  );
  let quotes: NativeQuotes;
  try {
    quotes = await dusk.get.previewVirtualBookQuotes(nativeSnapshot, {
      groupingBps,
      minContextSlot,
      signal,
    });
  } catch (error) {
    if (!unquotableAmount(error)) throw error;
    const curve = projectDuskVirtualBookCurve(nativeSnapshot, groupingBps);
    if (!curve) throw new Error('Market depth curve unavailable');
    quotes = await recoverExecutableVirtualBookQuotes(
      dusk,
      snapshot,
      groupingBps,
      curve,
      minContextSlot,
      signal,
    );
  }
  const after = await boundary.assertCompatibleForRead(deployment, signal, quotes.slot);
  if (signal?.aborted || after.observedSlot < quotes.slot)
    throw new Error('Native market depth was invalidated');
  return { ...quotes, deployment };
}
