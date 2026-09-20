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
export let DEFAULT_READONLY_PUBLIC_KEY: PublicKey;
export const decodePreviewMarketReturnData: Sdk['decodePreviewMarketReturnData'] =
  (...args) => sdkExports!.decodePreviewMarketReturnData(...args);
export const decodePreviewSwapReturnData: Sdk['decodePreviewSwapReturnData'] = (
  ...args
) => sdkExports!.decodePreviewSwapReturnData(...args);
export const deriveMarketAddress: Sdk['deriveMarketAddress'] = (...args) =>
  sdkExports!.deriveMarketAddress(...args);
export const deriveFutarchyAuthorityAddress: Sdk['deriveFutarchyAuthorityAddress'] =
  (...args) => sdkExports!.deriveFutarchyAuthorityAddress(...args);
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
  DEFAULT_READONLY_PUBLIC_KEY = sdkExports.DEFAULT_READONLY_PUBLIC_KEY;
  const provider = new AnchorProvider(
    connection,
    {
      publicKey: DEFAULT_READONLY_PUBLIC_KEY,
      signTransaction: async () => {
        throw new Error('Display previews never sign');
      },
      signAllTransactions: async () => {
        throw new Error('Display previews never sign');
      },
    },
    { commitment: 'confirmed' },
  );
  const sdk = new sdkExports.Dusk({
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
  return { sdk, boundary };
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
export function duskRawUnitsFromDecimal(
  value: string,
  decimals: number,
): bigint {
  if (
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > 255 ||
    !/^(0|[1-9][0-9]*)(\.[0-9]*)?$/.test(value)
  )
    throw new Error('Invalid VOB amount');
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > decimals) throw new Error('Invalid VOB precision');
  return (
    BigInt(whole) * 10n ** BigInt(decimals) +
    BigInt(fraction.padEnd(decimals, '0') || '0')
  );
}
