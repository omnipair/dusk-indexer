import { PublicKey } from '@solana/web3.js';
import type { Dusk } from '@omnipair/dusk-sdk';
import type { DuskDeploymentEnvelope } from './duskDeploymentService';
import { boundedDuskRpcRead } from './virtualBook/native';

export const ownerAccountNames = {
  borrow: 'borrowPosition',
  leverage: 'leveragePosition',
  yield: 'yieldAccount',
  'referral-accrual': 'referralAccrual',
} as const;
export type OwnerAccountKind = keyof typeof ownerAccountNames;
export interface OwnerAccountsSelection {
  owner: string;
  kind: OwnerAccountKind;
}

export function displayPublicKey(value: unknown): string {
  try {
    if (typeof value === 'string' && new PublicKey(value).toBase58() === value)
      return value;
  } catch {
    /* Report a client selection error, not an internal RPC failure. */
  }
  throw Object.assign(new Error('Invalid display account address'), {
    status: 400,
  });
}

export function ownerAccountsSelection(
  owner: unknown,
  kind: unknown,
): OwnerAccountsSelection {
  if (
    typeof kind !== 'string' ||
    !Object.prototype.hasOwnProperty.call(ownerAccountNames, kind)
  )
    throw Object.assign(new Error('Invalid owner account kind'), {
      status: 400,
    });
  return { owner: displayPublicKey(owner), kind: kind as OwnerAccountKind };
}

/** A complete confirmed snapshot. No pagination can mix different banks or hide
 * closed accounts. Raw bytes preserve the pinned SDK's lossless account types. */
export async function captureOwnerAccounts(
  dusk: Dusk,
  selection: OwnerAccountsSelection,
  deployment: DuskDeploymentEnvelope,
  signal?: AbortSignal,
) {
  const observedAt = Date.now();
  if (dusk.program.programId.toBase58() !== deployment.programId)
    throw new Error('Owner account SDK deployment mismatch');
  const name = ownerAccountNames[selection.kind];
  const discriminator = dusk.program.coder.accounts.memcmp(name);
  const result = await boundedDuskRpcRead(
    () =>
      dusk.program.provider.connection.getProgramAccounts(
        dusk.program.programId,
        {
          commitment: 'confirmed',
          withContext: true,
          minContextSlot: deployment.sourceSlot,
          filters: [
            { memcmp: discriminator },
            { memcmp: { offset: 8, bytes: selection.owner } },
          ],
        },
      ),
    signal,
  );
  if (
    !Number.isSafeInteger(result.context.slot) ||
    result.context.slot < deployment.sourceSlot ||
    result.value.length > 500
  )
    throw new Error(
      'Owner account snapshot is stale or exceeds its complete-snapshot limit',
    );
  const seen = new Set<string>();
  const accounts = result.value
    .map(({ pubkey, account }) => {
      const address = pubkey.toBase58();
      if (
        seen.has(address) ||
        account.executable ||
        !account.owner.equals(dusk.program.programId) ||
        account.data.length < 40 ||
        account.data.length > 8192
      )
        throw new Error('Invalid owner account snapshot');
      seen.add(address);
      const decoded = dusk.program.coder.accounts.decode(name, account.data);
      const owner =
        selection.kind === 'referral-accrual'
          ? decoded.referralPartner
          : decoded.owner;
      if (owner?.toBase58() !== selection.owner)
        throw new Error('Owner account snapshot crossed wallet scope');
      return { address, data: account.data.toString('base64') };
    })
    .sort((a, b) => a.address.localeCompare(b.address));
  return {
    schemaVersion: 'dusk-owner-accounts.v1' as const,
    ...selection,
    complete: true as const,
    sourceSlot: result.context.slot,
    observedAt,
    expiresAt: observedAt + 15_000,
    accounts,
  };
}
