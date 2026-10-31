// Backend display capture; ported from the reviewed webapp adapter.
import { decodePreviewHlpOrderTriggerReturnData } from './virtualBook/native';
import {
  ComputeBudgetProgram,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';

import { BN } from './virtualBook/native';
import { boundedDuskRpcRead } from './virtualBook/native';

import type { Dusk, HlpCohort, Market } from '@omnipair/dusk-sdk';
import { assertRetiredHlpCohort, hlpCohortAddress } from './duskHlpCohort';

/** The same native preview used by the delegate, including its 12-hour funding EMA. */
export async function previewDuskHlpOrderTrigger(
  dusk: Dusk,
  market: PublicKey,
  targetAsset: number,
  hlpAmount: { toString(): string },
  payer: string,
  floor: number,
  accounts?: string[],
  signal?: AbortSignal,
  expectedHlpMint?: PublicKey,
) {
  signal?.throwIfAborted();
  const cohort = expectedHlpMint ? hlpCohortAddress(market, expectedHlpMint, dusk.program.programId)[0] : null;
  if (cohort) accounts = [...new Set([...(accounts ?? []), market.toBase58(), cohort.toBase58()])];
  const instruction = await dusk.write.instruction('previewHlpOrderTrigger', {
    targetAsset, hlpAmount: new BN(hlpAmount.toString()),
  }, {
    accounts: { market },
    remainingAccounts: (accounts ?? []).filter(key => key !== market.toBase58())
      .map(key => ({ pubkey: new PublicKey(key),isSigner: false,isWritable: false })),
  });
  const tx = new VersionedTransaction(
    new TransactionMessage({
      payerKey: new PublicKey(payer),
      recentBlockhash: PublicKey.default.toBase58(),
      instructions: [
        ComputeBudgetProgram.requestHeapFrame({ bytes: 256 * 1024 }),
        ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
        instruction,
      ],
    }).compileToV0Message(),
  );
  const result = await boundedDuskRpcRead(
    () =>
      dusk.program.provider.connection.simulateTransaction(tx, {
        commitment: 'confirmed',
        minContextSlot: floor,
        sigVerify: false,
        replaceRecentBlockhash: true,
        ...(accounts
          ? { accounts: { encoding: 'base64' as const, addresses: accounts } }
          : {}),
      }),
    signal,
  );
  if (!Number.isSafeInteger(result.context.slot) || result.context.slot < floor)
    throw new Error('Order trigger preview is behind its order');
  if (result.value.err) return { slot: result.context.slot, value: null };
  if (expectedHlpMint) {
    const returned = (key: PublicKey) => {
      const info = result.value.accounts?.[accounts!.indexOf(key.toBase58())];
      if (!info || info.executable || info.owner !== dusk.program.programId.toBase58() || info.data[1] !== 'base64' ||
        Buffer.from(info.data[0], 'base64').toString('base64') !== info.data[0])
        throw new Error('Invalid hLP trigger cohort snapshot');
      return Buffer.from(info.data[0], 'base64');
    };
    const state = dusk.program.coder.accounts.decode<Market>('market', returned(market));
    if (!(targetAsset === 0 ? state.baseSide : state.quoteSide).hlpMint.equals(expectedHlpMint)) {
      const retired = dusk.program.coder.accounts.decode<HlpCohort>('hlpCohort', returned(cohort!));
      assertRetiredHlpCohort(retired, market, expectedHlpMint, dusk.program.programId, targetAsset);
      return { slot: result.context.slot, value: null, retired: true };
    }
  }
  const data = result.value.returnData;
  if (
    !data ||
    data.programId !== dusk.program.programId.toBase58() ||
    data.data[1] !== 'base64' ||
    Buffer.from(data.data[0], 'base64').toString('base64') !== data.data[0]
  )
    throw new Error('Invalid order trigger return data');
  return {
    slot: result.context.slot,
    value: decodePreviewHlpOrderTriggerReturnData(data.data),
    accounts: result.value.accounts,
  };
}
