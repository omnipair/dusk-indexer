// Native VOB computation ported from dusk-webapp 1834248f. Backend owns production sampling.
import {
  decodePreviewMarketReturnData,
  DEFAULT_READONLY_PUBLIC_KEY,
  deriveMarketAddress,
} from './native';
import {
  ComputeBudgetProgram,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';

import { minimumDuskReadSlot } from './native';
import { boundedDuskRpcRead } from './native';

import type { DuskDeploymentEnvelope } from '../duskDeploymentService';
import type { DuskReadBoundary } from './native';
import type { Dusk, Market } from './native';

/** A simulated, accrued account and its preview from the same confirmed bank.
 * This is display data only. Entry/close quotes still come from native previews.
 */
export async function readDuskVirtualBook({
  sdk,
  market,
  deployment,
  boundary,
  signal,
}: {
  sdk: Dusk;
  market: string;
  deployment: DuskDeploymentEnvelope;
  boundary: Pick<DuskReadBoundary, 'assertCompatibleForRead'>;
  signal?: AbortSignal;
}) {
  if (sdk.program.programId.toBase58() !== deployment.programId)
    throw new Error('Depth SDK deployment mismatch');
  const before = await boundary.assertCompatibleForRead(deployment, signal);
  const floor = Math.max(before.observedSlot, minimumDuskReadSlot(deployment));
  const instruction = await sdk.program.methods
    .previewMarket()
    .accountsStrict({ market: new PublicKey(market) })
    .instruction();
  const transaction = new VersionedTransaction(
    new TransactionMessage({
      payerKey: DEFAULT_READONLY_PUBLIC_KEY,
      recentBlockhash: PublicKey.default.toBase58(),
      instructions: [
        ComputeBudgetProgram.requestHeapFrame({ bytes: 256 * 1024 }),
        ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
        instruction,
      ],
    }).compileToV0Message(),
  );
  // Age begins when the bank observation is requested, after identity checks.
  const observedAt = Date.now();
  const result = await boundedDuskRpcRead(
    () =>
      sdk.program.provider.connection.simulateTransaction(transaction, {
        commitment: 'confirmed',
        minContextSlot: floor,
        replaceRecentBlockhash: true,
        sigVerify: false,
        accounts: { encoding: 'base64', addresses: [market] },
      }),
    signal,
    10_000,
  );
  const slot = result.context.slot;
  const data = result.value.returnData;
  const info = result.value.accounts?.[0];
  if (
    !Number.isSafeInteger(slot) ||
    slot < floor ||
    result.value.err ||
    !data ||
    data.programId !== deployment.programId ||
    data.data[1] !== 'base64' ||
    result.value.accounts?.length !== 1 ||
    !info ||
    info.owner !== deployment.programId ||
    info.executable ||
    info.data[1] !== 'base64'
  )
    throw new Error('Market depth snapshot unavailable');
  const accountBytes = Buffer.from(info.data[0], 'base64');
  if (accountBytes.toString('base64') !== info.data[0])
    throw new Error('Invalid depth account encoding');
  const preview = decodePreviewMarketReturnData(data.data);
  const account = sdk.program.coder.accounts.decode<Market>(
    'market',
    accountBytes,
  );
  const [address, bump] = deriveMarketAddress(
    account.baseSide.assetMint,
    account.quoteSide.assetMint,
    account.paramsHash,
  );
  if (
    preview.slot.toString() !== String(slot) ||
    account.version !== 1 ||
    !address.equals(new PublicKey(market)) ||
    account.bump !== bump ||
    !preview.amm.initialized ||
    account.amm.concentratedCurveCache.mathRevision !== 1
  )
    throw new Error('Incompatible depth snapshot');
  const after = await boundary.assertCompatibleForRead(deployment, signal);
  if (signal?.aborted || after.observedSlot < slot)
    throw new Error('Market depth was invalidated');
  return { market, deployment, slot, observedAt, account, preview };
}

export type DuskVirtualBookSnapshot = Awaited<
  ReturnType<typeof readDuskVirtualBook>
>;
