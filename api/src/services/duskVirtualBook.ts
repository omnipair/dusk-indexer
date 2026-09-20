import { randomUUID } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import {
  deploymentEnvelope,
  DuskDeploymentEnvelope,
} from './duskDeploymentService';
import { sharedDuskSnapshot } from './duskSharedSnapshot';
import {
  createVirtualBookRuntime,
  boundedDuskRpcRead,
} from './virtualBook/native';
import { readDuskVirtualBook } from './virtualBook/virtual-book-read';
import { readDuskVirtualBookQuotes } from './virtualBook/virtual-book-quotes';
import {
  projectDuskVirtualBook,
  VirtualBookView,
} from './virtualBook/virtual-book-view-model';

export const VIRTUAL_BOOK_MAX_AGE_MS = 20_000;
export interface VirtualBookSnapshot {
  schemaVersion: 'dusk-virtual-book.v1';
  revision: string;
  market: string;
  groupingBps: number;
  firstQuoteSlot: number;
  sourceSlot: number;
  observedAt: number;
  expiresAt: number;
  baseDecimals: number;
  quoteDecimals: number;
  book: VirtualBookView;
}
export interface VirtualBookEnvelope {
  success: true;
  data: VirtualBookSnapshot;
  deployment: DuskDeploymentEnvelope;
}
export interface VirtualBookSelection {
  market: string;
  groupingBps: number;
}
export function virtualBookSelection(
  market: unknown,
  grouping: unknown = '10',
): VirtualBookSelection {
  if (
    typeof market !== 'string' ||
    new PublicKey(market).toBase58() !== market ||
    typeof grouping !== 'string' ||
    !['5', '10', '25', '50', '100'].includes(grouping)
  )
    throw Object.assign(new Error('Invalid virtual book selection'), {
      status: 400,
    });
  return { market, groupingBps: Number(grouping) };
}
function intervalMs() {
  const interval = Number(process.env.DUSK_VIRTUAL_BOOK_INTERVAL_MS ?? 2000);
  if (!Number.isSafeInteger(interval) || interval < 1000 || interval > 5000)
    throw new Error('Invalid virtual book interval');
  return interval;
}
let runtime: ReturnType<typeof createVirtualBookRuntime> | undefined;
export async function captureVirtualBook(
  selection: VirtualBookSelection,
  deployment: DuskDeploymentEnvelope,
): Promise<VirtualBookEnvelope> {
  runtime ??= createVirtualBookRuntime().catch((error) => {
    runtime = undefined;
    throw error;
  });
  const { sdk, boundary } = await runtime;
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 15_000);
  try {
    const snapshot = await readDuskVirtualBook({
      sdk,
      market: selection.market,
      deployment,
      boundary,
      signal: controller.signal,
    });
    const quoted = await readDuskVirtualBookQuotes({
      sdk,
      snapshot,
      boundary,
      groupingBps: selection.groupingBps,
      signal: controller.signal,
    });
    const book = projectDuskVirtualBook(quoted);
    if (!book) throw new Error('Virtual book unavailable');
    const after = await boundedDuskRpcRead(
      () => deploymentEnvelope(quoted.slot, { fresh: true }),
      controller.signal,
    );
    if (after.deploymentIdentitySha256 !== deployment.deploymentIdentitySha256)
      throw new Error('Virtual book deployment changed');
    const data: VirtualBookSnapshot = {
      schemaVersion: 'dusk-virtual-book.v1',
      revision: randomUUID(),
      ...selection,
      firstQuoteSlot: quoted.firstQuoteSlot,
      sourceSlot: quoted.slot,
      observedAt: quoted.observedAt,
      expiresAt: quoted.observedAt + VIRTUAL_BOOK_MAX_AGE_MS,
      baseDecimals: quoted.account.baseSide.assetDecimals,
      quoteDecimals: quoted.account.quoteSide.assetDecimals,
      book,
    };
    if (Date.now() >= data.expiresAt)
      throw new Error('Virtual book expired during capture');
    return { success: true, data, deployment: after };
  } finally {
    clearTimeout(deadline);
  }
}
export interface VirtualBookDependencies {
  envelope: typeof deploymentEnvelope;
  shared: typeof sharedDuskSnapshot;
  capture: typeof captureVirtualBook;
}
const dependencies: VirtualBookDependencies = {
  envelope: deploymentEnvelope,
  shared: sharedDuskSnapshot,
  capture: captureVirtualBook,
};
export async function currentVirtualBook(
  selection: VirtualBookSelection,
  deps = dependencies,
): Promise<VirtualBookEnvelope | null> {
  const before = await boundedDuskRpcRead(() =>
    deps.envelope(0, { fresh: true }),
  );
  const key = `virtual-book.v1:${before.deploymentIdentitySha256}:${selection.market}:${selection.groupingBps}`;
  const result = await deps.shared({
    key,
    identity: before.deploymentIdentitySha256,
    intervalMs: intervalMs(),
    compute: () => deps.capture(selection, before),
  });
  const after = await boundedDuskRpcRead(() =>
    deps.envelope(Math.max(before.sourceSlot, result?.data.sourceSlot ?? 0), {
      fresh: true,
    }),
  );
  if (
    before.deploymentIdentitySha256 !== after.deploymentIdentitySha256 ||
    (result &&
      result.deployment.deploymentIdentitySha256 !==
        after.deploymentIdentitySha256)
  )
    throw new Error('Virtual book delivery deployment changed');
  if (!result || Date.now() >= result.data.expiresAt) return null;
  // Fresh delivery envelope, original observation time and immutable revision.
  return { ...result, deployment: after };
}
