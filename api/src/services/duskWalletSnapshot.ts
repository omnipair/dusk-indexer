import { randomUUID } from 'node:crypto';
import type { Dusk, LeveragePosition } from '@omnipair/dusk-sdk';
import type { DuskDeploymentEnvelope } from './duskDeploymentService';
import { captureOwnerAccounts } from './duskOwnerAccounts';
import {
  captureLeverageValuation,
  DuskLeverageValuationUnavailable,
} from './duskLeverageValuation';
import { readDuskOrders } from './duskOrderCapture';
import { type DuskReadBoundary } from './virtualBook/native';

/** Publish only complete batches; retain original per-observation slots. */
export async function completeBatch<T, R>(
  items: readonly T[],
  read: (item: T) => Promise<R>,
  concurrency = 6,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  if (!Number.isSafeInteger(concurrency) || concurrency < 1)
    throw new Error('Invalid batch concurrency');
  let next = 0,
    failure: unknown,
    failed = false;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (!failed && next < items.length) {
        const index = next++;
        try {
          results[index] = await read(items[index]);
        } catch (error) {
          failed = true;
          failure = error;
        }
      }
    }),
  );
  if (failed) throw failure;
  return results;
}
export const walletCaptureDependencies = {
  accounts: captureOwnerAccounts,
  valuation: captureLeverageValuation,
  orders: readDuskOrders,
};
export async function captureWalletSnapshot(
  dusk: Dusk,
  boundary: DuskReadBoundary,
  owner: string,
  deployment: DuskDeploymentEnvelope,
  signal?: AbortSignal,
  deps = walletCaptureDependencies,
) {
  const observedAt = Date.now(),
    selection = { owner, kind: 'leverage' as const };
  const accounts = await deps.accounts(dusk, selection, deployment, signal);
  const open = accounts.accounts.filter((row) => {
    const p = dusk.program.coder.accounts.decode<LeveragePosition>(
      'leveragePosition',
      Buffer.from(row.data, 'base64'),
    );
    return !p.collateralAmount.isZero() && !p.debtShares.isZero();
  });
  const captureDeployment = {
    ...deployment,
    sourceSlot: Math.max(deployment.sourceSlot, accounts.sourceSlot),
  };
  const [valuations, orders] = await Promise.all([
    completeBatch(open, async (row) => {
      try {
        return await deps.valuation(
          dusk,
          { owner, address: row.address },
          captureDeployment,
          signal,
        );
      } catch (error) {
        if (
          !(error instanceof DuskLeverageValuationUnavailable) ||
          error.address !== row.address
        )
          throw error;
        return {
          status: 'unavailable' as const,
          address: row.address,
          sourceSlot: error.sourceSlot,
          reason: 'close-rejected' as const,
        };
      }
    }),
    deps.orders({
      dusk,
      boundary,
      owner,
      deployment: captureDeployment,
      signal,
      previewPayer:
        process.env.DUSK_PREVIEW_PAYER?.trim() ||
        deployment.programUpgradeAuthority ||
        undefined,
    }),
  ]);
  const sourceSlot = Math.max(
    accounts.sourceSlot,
    orders.slot,
    ...valuations.map((row) => row.sourceSlot),
  );
  const verified = await deps.accounts(
    dusk,
    selection,
    {
      ...deployment,
      sourceSlot: Math.max(
        sourceSlot,
        ...valuations.map((value) =>
          'verificationSlot' in value
            ? value.verificationSlot
            : value.sourceSlot,
        ),
      ),
    },
    signal,
  );
  if (JSON.stringify(accounts.accounts) !== JSON.stringify(verified.accounts))
    throw new Error('Wallet positions changed during capture');
  for (const value of valuations) {
    if ('status' in value) continue;
    const raw = accounts.accounts.find(
      (row) => row.address === value.position.address,
    )!;
    const p = dusk.program.coder.accounts.decode<LeveragePosition>(
      'leveragePosition',
      Buffer.from(raw.data, 'base64'),
    );
    if (
      value.position.owner !== owner ||
      value.position.market !== p.market.toBase58() ||
      value.position.positionId !== p.positionId.toBase58() ||
      value.position.debtAsset !== p.debtAsset ||
      value.position.collateralRaw !== p.collateralAmount.toString() ||
      value.position.marginRaw !== p.marginAmount.toString() ||
      value.position.notionalRaw !== p.openNotional.toString() ||
      value.position.debtShares !== p.debtShares.toString() ||
      value.position.debtPrincipal !== p.debtPrincipal.toString()
    )
      throw new Error('Wallet valuation changed during capture');
  }
  const encode = async (kind: 'exit' | 'entry' | 'hlp') =>
    orders[kind].map((row) => ({
      address: row.address,
      account: row.raw.account.toString('base64'),
      market: row.raw.market.toString('base64'),
      position: row.raw.position?.toString('base64') ?? null,
      unixTimestamp: row.unixTimestamp.toString(),
      slot: row.slot,
      entryMark: row.entryMark
        ? { ...row.entryMark, priceNad: row.entryMark.priceNad.toString() }
        : null,
      trigger: row.trigger
        ? {
            fundingAprEmaNad: row.trigger.fundingAprEmaNad.toString(),
            principalNavPerTokenNad:
              row.trigger.principalNavPerTokenNad.toString(),
          }
        : null,
    }));
  const [exit, entry, hlp] = await Promise.all([
    encode('exit'),
    encode('entry'),
    encode('hlp'),
  ]);
  signal?.throwIfAborted();
  if (Date.now() >= observedAt + 15_000)
    throw new Error('Wallet capture expired');
  return {
    schemaVersion: 'dusk-wallet.v1' as const,
    owner,
    complete: true,
    revision: randomUUID(),
    observedAt,
    expiresAt: observedAt + 15_000,
    sourceSlot,
    verificationSlot: verified.sourceSlot,
    accounts,
    valuations,
    orders: {
      owner,
      observedAt: orders.observedAt,
      slot: orders.slot,
      exit,
      entry,
      hlp,
    },
  };
}
