import { AnchorProvider, BN } from '@coral-xyz/anchor';
import { Connection, PublicKey } from '@solana/web3.js';
import {
  canonicalJson,
  duskApiConfig,
  loadPinnedProtocol,
  sha256,
} from '../../config/duskProtocol';
import {
  deploymentEnvelope,
  DuskDeploymentEnvelope,
} from '../duskDeploymentService';
export { BN };
export type { Dusk, Market, SwapPreview } from '@omnipair/dusk-sdk';
type Sdk = typeof import('@omnipair/dusk-sdk');
// Preserve native ESM loading inside this CommonJS API. The SDK has an import-only export.
const importSdk = new Function(
  "return import('@omnipair/dusk-sdk')",
) as () => Promise<Sdk>;
let sdkExports: Sdk | undefined;
// Native ESM imports are initialized once by createVirtualBookRuntime.
export const decodePreviewSwapReturnData: Sdk['decodePreviewSwapReturnData'] = (
  ...args
) => sdkExports!.decodePreviewSwapReturnData(...args);
export const decodeDuskVirtualBookBatch: Sdk['decodeDuskVirtualBookBatch'] = (
  ...args
) => sdkExports!.decodeDuskVirtualBookBatch(...args);
export const projectDuskVirtualBook: Sdk['projectDuskVirtualBook'] = (
  ...args
) => sdkExports!.projectDuskVirtualBook(...args);
export const createLeverageDelegateProgram: Sdk['createLeverageDelegateProgram'] =
  (...args) => sdkExports!.createLeverageDelegateProgram(...args);
export const deriveLeverageOrderAddress: Sdk['deriveLeverageOrderAddress'] = (
  ...args
) => sdkExports!.deriveLeverageOrderAddress(...args);
export const deriveLeveragePositionAddress: Sdk['deriveLeveragePositionAddress'] =
  (...args) => sdkExports!.deriveLeveragePositionAddress(...args);
export const deriveMarketAddress: Sdk['deriveMarketAddress'] = (...args) =>
  sdkExports!.deriveMarketAddress(...args);
export const deriveReferralAccrualAddress: Sdk['deriveReferralAccrualAddress'] =
  (...args) => sdkExports!.deriveReferralAccrualAddress(...args);
export const deriveReferralPartnerAddress: Sdk['deriveReferralPartnerAddress'] =
  (...args) => sdkExports!.deriveReferralPartnerAddress(...args);
export const decodePreviewHlpOrderTriggerReturnData: Sdk['decodePreviewHlpOrderTriggerReturnData'] =
  (...args) => sdkExports!.decodePreviewHlpOrderTriggerReturnData(...args);
export const minimumDuskReadSlot = (deployment: DuskDeploymentEnvelope) =>
  Math.max(
    Number(deployment.programDataSlot),
    Number(deployment.leverageDelegateProgramDataSlot),
  ) + 1;
export interface DuskReadBoundary {
  assertCompatibleForRead(
    deployment: DuskDeploymentEnvelope,
    signal?: AbortSignal,
  ): Promise<{ observedSlot: number }>;
}
export async function createVirtualBookRuntime(
  connection = new Connection(duskApiConfig().rpcUrl, 'confirmed'),
) {
  const sdkModule = await importSdk();
  const pin = loadPinnedProtocol();
  if (sha256(canonicalJson(sdkModule.IDL)) !== pin.dusk.idlCanonicalSha256)
    throw new Error('VOB SDK IDL differs from the pinned deployment');
  sdkExports = sdkModule;

  const provider = new AnchorProvider(
    connection,
    {
      publicKey: sdkExports.DEFAULT_READONLY_PUBLIC_KEY,
      signTransaction: async () => {
        throw new Error('Display previews never sign');
      },
      signAllTransactions: async () => {
        throw new Error('Display previews never sign');
      },
    },
    { commitment: 'confirmed' },
  );
  const dusk = new sdkExports.Dusk({
    provider,
    programId: new PublicKey(pin.dusk.programId),
  });
  const boundary: DuskReadBoundary = {
    async assertCompatibleForRead(expected, signal) {
      const observed = await boundedDuskRpcRead(
        () => deploymentEnvelope(expected.sourceSlot, { fresh: true }),
        signal,
      );
      if (
        observed.deploymentIdentitySha256 !== expected.deploymentIdentitySha256
      )
        throw new Error('VOB deployment changed');
      return { observedSlot: observed.sourceSlot };
    },
  };
  return { dusk, boundary };
}
export async function boundedDuskRpcRead<T>(
  read: () => Promise<T>,
  signal?: AbortSignal,
  timeoutMs = 10_000,
): Promise<T> {
  signal?.throwIfAborted();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel = () => {};
  const deadline = new Promise<never>((_, reject) => {
    cancel = () => reject(new Error('VOB read cancelled'));
    signal?.addEventListener('abort', cancel, { once: true });
    timer = setTimeout(
      () => reject(new Error('VOB read timed out')),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([read(), deadline]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}
