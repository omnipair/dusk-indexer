// Native VOB computation ported from dusk-webapp 1834248f. Backend owns production sampling.
import {
  decodePreviewSwapReturnData,
  DEFAULT_READONLY_PUBLIC_KEY,
  deriveFutarchyAuthorityAddress,
  deriveMarketAddress,
} from './native';
import {
  calculateEpochFee,
  getTransferFeeConfig,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  unpackMint,
} from '@solana/spl-token';
import {
  ComputeBudgetProgram,
  PublicKey,
  SYSVAR_CLOCK_PUBKEY,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';

import { duskRawUnitsFromDecimal } from './native';
import { BN } from './native';
import { minimumDuskReadSlot } from './native';
import { boundedDuskRpcRead } from './native';
import { projectDuskVirtualBookCurve } from './virtual-book-view-model';

import type { DuskReadBoundary } from './native';
import type { DuskVirtualBookSnapshot } from './virtual-book-read';
import type { Dusk, Market, SwapPreview } from './native';
import type {
  AccountInfo,
  RpcResponseAndContext,
  SimulatedTransactionResponse,
} from '@solana/web3.js';

type Side = 'bids' | 'asks';
export type VirtualBookQuoteRequest = { side: Side; amount: bigint };
export type VirtualBookQuote = {
  preview: SwapPreview;
  outputTransferFee: bigint;
  slot: number;
};
export type DuskVirtualBookQuotes = DuskVirtualBookSnapshot & {
  groupingBps: number;
  firstQuoteSlot: number;
  mid: number;
  quotes: Record<Side, VirtualBookQuote[]>;
};
const CLOCK_OWNER = 'Sysvar1111111111111111111111111111111111111';
const BATCH_SIZE = 4;
const U64_MAX = (1n << 64n) - 1n;
const raw = (value: { toString(): string }) => {
  const amount = BigInt(value.toString());
  if (amount < 0n || amount > U64_MAX) throw new Error('Invalid depth amount');
  return amount;
};
const canonicalBytes = (data: string[]) => {
  if (
    data.length !== 2 ||
    data[1] !== 'base64' ||
    Buffer.from(data[0], 'base64').toString('base64') !== data[0]
  )
    throw new Error('Invalid native depth encoding');
  return Buffer.from(data[0], 'base64');
};

/** Only the requested top-level, read-only SDK previews can supply these returns. */
export function decodeDuskVirtualBookBatch(
  sdk: Dusk,
  snapshot: DuskVirtualBookSnapshot,
  requests: VirtualBookQuoteRequest[],
  result: RpcResponseAndContext<SimulatedTransactionResponse>,
  floor: number,
) {
  const { slot } = result.context;
  const { value } = result;
  const programId = snapshot.deployment.programId;
  if (!Number.isSafeInteger(slot) || slot < floor || value.err)
    throw new Error('Native market depth preview unavailable');
  const returned = value.returnData;
  const accounts = value.accounts;
  if (!returned || returned.programId !== programId || accounts?.length !== 5)
    throw new Error('Incomplete native market depth preview');
  const infos: AccountInfo<Buffer>[] = accounts.map((info) => {
    if (!info || info.executable)
      throw new Error('Invalid native depth account');
    return {
      owner: new PublicKey(info.owner),
      executable: false,
      lamports: info.lamports,
      data: canonicalBytes(info.data),
    };
  });
  const [marketInfo, baseInfo, quoteInfo, authorityInfo, clock] = infos;
  if (
    marketInfo.owner.toBase58() !== programId ||
    authorityInfo.owner.toBase58() !== programId ||
    clock.owner.toBase58() !== CLOCK_OWNER ||
    clock.data.length !== 40 ||
    clock.data.readBigUInt64LE(0) !== BigInt(slot)
  )
    throw new Error('Native depth account identity or clock mismatch');
  const epoch = clock.data.readBigUInt64LE(16);
  const market = sdk.program.coder.accounts.decode<Market>(
    'market',
    marketInfo.data,
  );
  const [address, bump] = deriveMarketAddress(
    market.baseSide.assetMint,
    market.quoteSide.assetMint,
    market.paramsHash,
  );
  if (
    market.version !== 1 ||
    market.bump !== bump ||
    address.toBase58() !== snapshot.market ||
    !market.baseSide.assetMint.equals(snapshot.account.baseSide.assetMint) ||
    !market.quoteSide.assetMint.equals(snapshot.account.quoteSide.assetMint) ||
    market.amm.concentratedCurveCache.mathRevision !== 1
  )
    throw new Error('Native depth market identity changed');
  const mint = (info: AccountInfo<Buffer>, side: Market['baseSide']) => {
    if (
      !info.owner.equals(TOKEN_PROGRAM_ID) &&
      !info.owner.equals(TOKEN_2022_PROGRAM_ID)
    )
      throw new Error('Invalid depth token program');
    const decoded = unpackMint(side.assetMint, info, info.owner);
    if (!decoded.isInitialized || decoded.decimals !== side.assetDecimals)
      throw new Error('Depth token precision changed');
    return decoded;
  };
  const base = mint(baseInfo, market.baseSide);
  const quote = mint(quoteInfo, market.quoteSide);
  const prefix = `Program return: ${programId} `;
  const returns = (value.logs ?? [])
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length));
  if (
    returns.length !== requests.length ||
    returns[returns.length - 1] !== returned.data[0]
  )
    throw new Error('Incomplete native depth return log');
  canonicalBytes(returned.data);
  const quotes = returns.map((encoded, index) => {
    canonicalBytes([encoded, 'base64']);
    const preview = decodePreviewSwapReturnData([encoded, 'base64']);
    const request = requests[index];
    const fromBase = request.side === 'bids';
    if (
      Object.keys(preview.assetIn).join() !== (fromBase ? 'base' : 'quote') ||
      Object.keys(preview.assetOut).join() !== (fromBase ? 'quote' : 'base') ||
      raw(preview.exactAssetIn) !== request.amount ||
      raw(preview.startPriceNad) === 0n ||
      raw(preview.totalFeeRateNad) > 1_000_000_000n ||
      raw(preview.divergenceFeeRateNad) + raw(preview.volatilityFeeRateNad) >
        raw(preview.totalFeeRateNad)
    )
      throw new Error('Native depth quote does not match its request');
    // SwapPreview.amountOut is the vault debit. The real swap applies the
    // output mint's transfer fee once more before crediting the user's account.
    const transferFees = getTransferFeeConfig(fromBase ? quote : base);
    const outputTransferFee = transferFees
      ? calculateEpochFee(transferFees, epoch, raw(preview.amountOut))
      : 0n;
    return { side: request.side, preview, outputTransferFee, slot };
  });
  return {
    market,
    quotes,
    slot,
    epoch,
    // Equal market, mint and authority bytes prevent combining quotes across
    // trades, fee changes or token-extension changes during this short burst.
    state: infos
      .slice(0, 4)
      .map((info) => `${info.owner}:${info.data.toString('base64')}`)
      .join('|'),
  };
}

/** One native quote per cumulative size; no flat-fee approximation or pre-fee fallback. */
export async function readDuskVirtualBookQuotes({
  sdk,
  snapshot,
  boundary,
  groupingBps = 10,
  signal,
}: {
  sdk: Dusk;
  snapshot: DuskVirtualBookSnapshot;
  boundary: Pick<DuskReadBoundary, 'assertCompatibleForRead'>;
  groupingBps?: number;
  signal?: AbortSignal;
}): Promise<DuskVirtualBookQuotes> {
  const { deployment, market, account } = snapshot;
  if (sdk.program.programId.toBase58() !== deployment.programId)
    throw new Error('Depth SDK deployment mismatch');
  const curve = projectDuskVirtualBookCurve(snapshot, groupingBps);
  if (!curve) throw new Error('Market depth curve unavailable');
  const before = await boundary.assertCompatibleForRead(deployment, signal);
  const floor = Math.max(
    snapshot.slot,
    before.observedSlot,
    minimumDuskReadSlot(deployment),
  );
  const requests: VirtualBookQuoteRequest[] = [];
  for (const side of ['bids', 'asks'] as const) {
    let previous = 0n;
    const decimals =
      side === 'bids'
        ? account.baseSide.assetDecimals
        : account.quoteSide.assetDecimals;
    for (const level of curve[side]) {
      const amount = raw(
        duskRawUnitsFromDecimal(
          (side === 'bids' ? level.total : level.quoteTotal).toFixed(decimals),
          decimals,
        ),
      );
      if (amount <= previous) continue;
      requests.push({ side, amount });
      previous = amount;
    }
  }
  const batches: VirtualBookQuoteRequest[][] = [];
  for (let i = 0; i < requests.length; i += BATCH_SIZE)
    batches.push(requests.slice(i, i + BATCH_SIZE));
  const results = await Promise.all(
    batches.map(async (batch) => {
      signal?.throwIfAborted();
      const instructions = await Promise.all(
        batch.map(({ side, amount }) => {
          const fromBase = side === 'bids';
          return sdk.program.methods
            .previewSwap({ exactAssetIn: new BN(amount.toString()) })
            .accountsPartial({
              market: new PublicKey(market),
              futarchyAuthority: deriveFutarchyAuthorityAddress()[0],
              assetInMint: fromBase
                ? account.baseSide.assetMint
                : account.quoteSide.assetMint,
              assetOutMint: fromBase
                ? account.quoteSide.assetMint
                : account.baseSide.assetMint,
            })
            .instruction();
        }),
      );
      const transaction = new VersionedTransaction(
        new TransactionMessage({
          payerKey: DEFAULT_READONLY_PUBLIC_KEY,
          recentBlockhash: PublicKey.default.toBase58(),
          instructions: [
            ComputeBudgetProgram.requestHeapFrame({ bytes: 256 * 1024 }),
            ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
            ...instructions,
          ],
        }).compileToV0Message(),
      );
      const response = await boundedDuskRpcRead(
        () =>
          sdk.program.provider.connection.simulateTransaction(transaction, {
            commitment: 'confirmed',
            minContextSlot: floor,
            sigVerify: false,
            replaceRecentBlockhash: true,
            accounts: {
              encoding: 'base64',
              addresses: [
                market,
                account.baseSide.assetMint.toBase58(),
                account.quoteSide.assetMint.toBase58(),
                deriveFutarchyAuthorityAddress()[0].toBase58(),
                SYSVAR_CLOCK_PUBKEY.toBase58(),
              ],
            },
          }),
        signal,
      );
      return decodeDuskVirtualBookBatch(sdk, snapshot, batch, response, floor);
    }),
  );
  const first = results[0];
  const lastSlot = Math.max(
    snapshot.slot,
    ...results.map((result) => result.slot),
  );
  const firstQuoteSlot = results.length
    ? Math.min(...results.map((result) => result.slot))
    : snapshot.slot;
  if (
    lastSlot - firstQuoteSlot > 8 ||
    results.some(
      (result) => result.state !== first.state || result.epoch !== first.epoch,
    )
  )
    throw new Error('Market depth changed during native previews');
  const allQuotes = results.flatMap((result) => result.quotes);
  const start = allQuotes[0]?.preview.startPriceNad.toString();
  if (
    allQuotes.some((quote) => quote.preview.startPriceNad.toString() !== start)
  )
    throw new Error('Market depth price changed during native previews');
  const after = await boundary.assertCompatibleForRead(deployment, signal);
  if (signal?.aborted || after.observedSlot < lastSlot)
    throw new Error('Native market depth was invalidated');
  return {
    ...snapshot,
    account: first?.market ?? account,
    slot: lastSlot,
    firstQuoteSlot,
    groupingBps,
    mid: start ? Number(start) / 1e9 : curve.mid,
    quotes: {
      bids: allQuotes.filter((quote) => quote.side === 'bids'),
      asks: allQuotes.filter((quote) => quote.side === 'asks'),
    },
  };
}
