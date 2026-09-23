import {
  deploymentEnvelope,
  DuskDeploymentEnvelope,
} from './duskDeploymentService';
import { sharedDuskSnapshot } from './duskSharedSnapshot';
import { createVirtualBookRuntime } from './virtualBook/native';
import {
  captureOwnerAccounts,
  OwnerAccountsSelection,
} from './duskOwnerAccounts';
import {
  captureLeverageValuation,
  LeverageValuationSelection,
} from './duskLeverageValuation';

let runtime: ReturnType<typeof createVirtualBookRuntime> | undefined;
export async function displayRuntime() {
  runtime ??= createVirtualBookRuntime().catch((error) => {
    runtime = undefined;
    throw error;
  });
  return runtime;
}

export const displayStateDependencies = {
  envelope: deploymentEnvelope,
  shared: sharedDuskSnapshot,
};
/** Persist and coalesce captures across API replicas. Delivery never renews an
 * observation's age, and cache hits still belong to the same deployment. */
export async function currentDisplayState<
  T extends {
    sourceSlot: number;
    verificationSlot?: number;
    observedAt: number;
    expiresAt: number;
  },
>(
  key: string,
  capture: (deployment: DuskDeploymentEnvelope) => Promise<T>,
  deps = displayStateDependencies,
) {
  const before = await deps.envelope(0, { fresh: true });
  const result = await deps.shared({
    key: `display.v1:${before.deploymentIdentitySha256}:${key}`,
    identity: before.deploymentIdentitySha256,
    intervalMs: 2000,
    compute: async () => ({
      success: true as const,
      deployment: before,
      data: await capture(before),
    }),
  });
  const after = await deps.envelope(
    Math.max(
      before.sourceSlot,
      result?.data.sourceSlot ?? 0,
      result?.data.verificationSlot ?? 0,
    ),
    { fresh: true },
  );
  if (
    before.deploymentIdentitySha256 !== after.deploymentIdentitySha256 ||
    (result &&
      result.deployment.deploymentIdentitySha256 !==
        after.deploymentIdentitySha256)
  )
    throw new Error('Display snapshot deployment changed');
  if (
    !result ||
    Date.now() >= result.data.expiresAt ||
    result.data.observedAt > Date.now()
  )
    throw Object.assign(
      new Error('Display snapshot is unavailable or expired'),
      { status: 503 },
    );
  return { ...result, deployment: after };
}

async function captureWithDeadline<T>(
  capture: (signal: AbortSignal) => Promise<T>,
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 14_000);
  try {
    return await capture(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

export function currentOwnerAccounts(selection: OwnerAccountsSelection) {
  return currentDisplayState(
    `accounts:${selection.kind}:${selection.owner}`,
    async (deployment) => {
      const { dusk } = await displayRuntime();
      return captureWithDeadline((signal) =>
        captureOwnerAccounts(dusk, selection, deployment, signal),
      );
    },
  );
}

export function currentLeverageValuation(
  selection: LeverageValuationSelection,
) {
  return currentDisplayState(
    `leverage:${selection.owner}:${selection.address}`,
    async (deployment) => {
      const { dusk } = await displayRuntime();
      return captureWithDeadline((signal) =>
        captureLeverageValuation(dusk, selection, deployment, signal),
      );
    },
  );
}
