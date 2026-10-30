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

/** The preview a simulated batch failed on. The two compute-budget
 * instructions come first, so previews start at instruction 2. */
function failedPreview(error: unknown) {
  if (!(error instanceof Error) || error.name !== 'DuskSimulationError')
    return undefined;
  const value = (error as Error & {
    simulation?: { value?: { err?: unknown; logs?: unknown } };
  }).simulation?.value;
  const instruction = (value?.err as {
    InstructionError?: unknown;
  } | null)?.InstructionError;
  if (
    !Array.isArray(instruction) ||
    !Number.isSafeInteger(instruction[0]) ||
    instruction[0] < 2
  )
    return undefined;
  return {
    reason: instruction[1],
    logs: Array.isArray(value?.logs) ? value.logs : [],
  };
}

/** BrokenInvariant means this exact cumulative input cannot execute at the
 * observed bank. Omit that level; all other simulation failures invalidate the
 * book rather than being treated as missing liquidity. */
export function unquotableAmount(error: unknown): boolean {
  return failedPreview(error)?.reason?.Custom === 6047;
}

/** The batch ran out of compute, which is metered per transaction. Fewer
 * previews per simulation fit; a single preview that runs out cannot. */
export function computeExhausted(error: unknown): boolean {
  const failure = failedPreview(error);
  return (
    failure?.reason === 'ComputationalBudgetExceeded' ||
    (failure?.reason === 'ProgramFailedToComplete' &&
      failure.logs.some(line =>
        /^Program \w+ failed: exceeded CUs meter at BPF instruction/.test(line),
      ))
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
  const options = { minContextSlot, signal };
  // Halve a batch that runs out of compute (4, 2, then 1). Retry a batch with
  // an unquotable amount one request at a time and omit what still fails.
  const preview = async (batch: VirtualBookQuoteRequest[]): Promise<BatchResult[]> => {
    try {
      return [await dusk.get.previewVirtualBookBatch(nativeSnapshot, batch, options)];
    } catch (error) {
      if (batch.length > 1 && computeExhausted(error)) {
        const half = Math.ceil(batch.length / 2);
        return (await Promise.all(
          [batch.slice(0, half), batch.slice(half)].map(preview),
        )).flat();
      }
      if (!unquotableAmount(error)) throw error;
      if (batch.length === 1) return [];
      return (await Promise.all(batch.map(request => preview([request])))).flat();
    }
  };
  const batches: VirtualBookQuoteRequest[][] = [];
  for (let i = 0; i < requests.length; i += 4)
    batches.push(requests.slice(i, i + 4));
  const results = (await Promise.all(batches.map(preview))).flat();
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
    if (!unquotableAmount(error) && !computeExhausted(error)) throw error;
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
