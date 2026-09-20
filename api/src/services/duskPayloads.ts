import { randomUUID } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import {
  deploymentEnvelope,
  DuskDeploymentEnvelope,
  withDeploymentRead,
} from './duskDeploymentService';
import { deploymentSnapshot } from './duskMarketSurface';
import { listEventHistory } from './duskEventHistory';
import { listQuoteHistory } from './duskQuoteHistory';
import { sharedDuskSnapshot } from './duskSharedSnapshot';

export type PayloadSelection =
  | { kind: 'markets' }
  | { kind: 'trades'; market: string }
  | {
      kind: 'candles';
      market: string;
      side: 'base' | 'quote';
      resolutionSeconds: number;
    };
export interface PayloadEnvelope {
  success: true;
  deployment: DuskDeploymentEnvelope;
  data: {
    schemaVersion: 'dusk-payload.v1';
    selection: PayloadSelection;
    revision: string;
    observedAt: number;
    expiresAt: number;
    sourceSlot: number;
    payload: unknown;
  };
}
export function payloadSelection(
  input: Record<string, unknown>,
): PayloadSelection {
  const invalid = (): never => {
    throw Object.assign(new Error('Invalid payload subscription'), {
      status: 400,
    });
  };
  if (input.kind === 'markets') {
    if (Object.keys(input).some((key) => key !== 'kind')) invalid();
    return { kind: 'markets' };
  }
  if (typeof input.market !== 'string') return invalid();
  try {
    if (new PublicKey(input.market).toBase58() !== input.market) invalid();
  } catch {
    return invalid();
  }
  if (
    input.kind === 'trades' &&
    Object.keys(input).every((key) => ['kind', 'market'].includes(key))
  )
    return { kind: 'trades', market: input.market };
  if (
    input.kind !== 'candles' ||
    Object.keys(input).some(
      (key) => !['kind', 'market', 'side', 'resolutionSeconds'].includes(key),
    ) ||
    !['base', 'quote'].includes(String(input.side)) ||
    typeof input.resolutionSeconds !== 'string' ||
    !['60', '300', '900', '3600', '14400', '86400'].includes(
      input.resolutionSeconds,
    )
  )
    return invalid();
  return {
    kind: 'candles',
    market: input.market,
    side: input.side as 'base' | 'quote',
    resolutionSeconds: Number(input.resolutionSeconds),
  };
}
export const payloadLifetime = (selection: PayloadSelection) =>
  selection.kind === 'markets' ? 15_000 : 60_000;

/** Full bounded snapshots recover without a per-subscriber replay log. Older
 * history is still paginated through the existing immutable cursor endpoints. */
export async function capturePayload(
  selection: PayloadSelection,
): Promise<PayloadEnvelope> {
  const observedAt = Date.now();
  const result = await withDeploymentRead<unknown>(async (deployment) => {
    if (selection.kind === 'markets') {
      const { config, projected, sourceSlot } =
        await deploymentSnapshot(deployment);
      return {
        data: {
          configuration: config,
          markets: projected,
          pagination: {
            limit: Math.max(100, projected.length),
            offset: 0,
            total: projected.length,
          },
        },
        sourceSlot,
      };
    }
    const until = new Date(Math.floor(observedAt / 1000) * 1000).toISOString();
    if (selection.kind === 'trades') {
      const data = await listEventHistory({
        version: 2,
        market: selection.market,
        until,
        limit: 100,
        deploymentIdentitySha256: deployment.deploymentIdentitySha256,
      });
      return {
        data,
        sourceSlot: Math.max(0, ...data.events.map((row) => Number(row.slot))),
      };
    }
    const end = Date.parse(until) / 1000;
    const since = new Date(
      Math.max(
        0,
        (Math.ceil(end / selection.resolutionSeconds) - 2000) *
          selection.resolutionSeconds,
      ) * 1000,
    ).toISOString();
    const data = await listQuoteHistory({
      market: selection.market,
      side: selection.side,
      resolutionSeconds: selection.resolutionSeconds,
      since,
      until,
      deployment,
      deploymentIdentitySha256: deployment.deploymentIdentitySha256,
    });
    const history = 'history' in data ? data.history : data;
    return {
      data: history,
      sourceSlot: Number(history.coverage.lastSourceSlot ?? 0),
    };
  });
  const expiresAt = observedAt + payloadLifetime(selection);
  if (Date.now() >= expiresAt)
    throw new Error('Payload expired during capture');
  return {
    success: true,
    deployment: result.deployment,
    data: {
      schemaVersion: 'dusk-payload.v1',
      selection,
      revision: randomUUID(),
      observedAt,
      expiresAt,
      sourceSlot: result.deployment.sourceSlot,
      payload: result.data,
    },
  };
}
export const payloadDependencies = {
  envelope: deploymentEnvelope,
  shared: sharedDuskSnapshot,
  capture: capturePayload,
};
export async function currentPayload(
  selection: PayloadSelection,
  deps = payloadDependencies,
): Promise<PayloadEnvelope | null> {
  const before = await deps.envelope(0, { fresh: true });
  const result = await deps.shared({
    key: `payload.v1:${before.deploymentIdentitySha256}:${JSON.stringify(selection)}`,
    identity: before.deploymentIdentitySha256,
    intervalMs: selection.kind === 'candles' ? 5000 : 2000,
    compute: () => deps.capture(selection),
  });
  const after = await deps.envelope(
    Math.max(before.sourceSlot, result?.data.sourceSlot ?? 0),
    { fresh: true },
  );
  if (
    before.deploymentIdentitySha256 !== after.deploymentIdentitySha256 ||
    (result &&
      result.deployment.deploymentIdentitySha256 !==
        after.deploymentIdentitySha256)
  )
    throw new Error('Payload deployment changed');
  if (!result || Date.now() >= result.data.expiresAt) return null;
  // Original payload and observation timestamps survive cache hits. This fresh
  // envelope only proves that delivery still uses the same deployment.
  return { ...result, deployment: after };
}
