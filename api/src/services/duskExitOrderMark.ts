import { ComputeBudgetProgram, PublicKey, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import type { Dusk, Market } from '@omnipair/dusk-sdk';
import { boundedDuskRpcRead } from './virtualBook/native';
import { marketLayoutVersion } from './duskProtocolSchema';

/** Preview the current-slot risk EMA used by the delegate. No transaction is sent. */
export async function previewDuskExitOrderMark(
  dusk: Dusk, address: PublicKey, expected: Market, debtAsset: number,
  payer: string, floor: number, signal?: AbortSignal,
) {
  if (![0, 1].includes(debtAsset)) throw new Error('Invalid exit debt side');
  const instruction = await dusk.write.instruction('previewMarket', [], { accounts: { market: address } });
  const tx = new VersionedTransaction(new TransactionMessage({
    payerKey: new PublicKey(payer), recentBlockhash: PublicKey.default.toBase58(),
    instructions: [ComputeBudgetProgram.requestHeapFrame({ bytes: 256 * 1024 }),
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), instruction],
  }).compileToV0Message());
  const result = await boundedDuskRpcRead(() => dusk.program.provider.connection.simulateTransaction(tx, {
    commitment: 'confirmed', minContextSlot: floor, sigVerify: false, replaceRecentBlockhash: true,
    accounts: { encoding: 'base64', addresses: [address.toBase58()] },
  }), signal);
  if (!Number.isSafeInteger(result.context.slot) || result.context.slot < floor)
    throw new Error('Exit EMA preview is behind its order');
  if (result.value.err) return null;
  const raw = result.value.accounts?.[0];
  if (!raw || raw.executable || raw.owner !== dusk.program.programId.toBase58() || raw.data[1] !== 'base64')
    throw new Error('Invalid exit EMA market');
  const bytes = Buffer.from(raw.data[0], 'base64');
  if (bytes.toString('base64') !== raw.data[0]) throw new Error('Invalid exit EMA encoding');
  const market = dusk.program.coder.accounts.decode<Market>('market', bytes);
  if (market.version !== marketLayoutVersion() ||
      !market.baseSide.assetMint.equals(expected.baseSide.assetMint) ||
      !market.quoteSide.assetMint.equals(expected.quoteSide.assetMint) ||
      !market.srlpMint.equals(expected.srlpMint) ||
      Buffer.from(market.paramsHash).compare(Buffer.from(expected.paramsHash)) !== 0 ||
      market.risk.lastSnapshotSlot.toString() !== String(result.context.slot))
    throw new Error('Exit EMA identity or snapshot changed');
  const priceNad = BigInt(market.risk[debtAsset === 0 ? 'quotePriceEmaNad' : 'basePriceEmaNad'].toString());
  if (priceNad <= 0n) return null;
  return { slot: result.context.slot, observedAt: Date.now(), priceNad };
}
