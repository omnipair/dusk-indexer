/** SDK-compatible, non-signing simulation transport over one captured bank. */
import { Connection, ComputeBudgetProgram, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { address, getTransactionDecoder } from '@solana/kit';
import { FailedTransactionMetadata, LiteSVM } from 'litesvm';
import { InstructionErrorFieldless } from 'litesvm/dist/internal';
import type { FrozenLeverageBank } from './duskLeverageMaximumInput';

export function frozenPreviewConnection(svm: LiteSVM,bank: FrozenLeverageBank,programId: string,discriminators: readonly Uint8Array[]): Connection {
  const readAccount = (key: PublicKey) => {
    const original = bank.accounts.find(row => row.address===key.toBase58())?.account;
    if (original) return { ...original,owner: new PublicKey(original.owner),data: Buffer.from(original.data,'base64'),rentEpoch: Number(original.rentEpoch) };
    const loaded = svm.getAccount(address(key.toBase58()));
    return loaded.exists ? { owner: new PublicKey(loaded.programAddress),data: Buffer.from(loaded.data),lamports: Number(loaded.lamports),executable: loaded.executable,rentEpoch: 0 } : null;
  };
  const assertFloor = (config?: { minContextSlot?: number }) => {
    if ((config?.minContextSlot ?? 0)>bank.slot) throw new Error('Frozen preview bank is behind the read floor');
  };
  const transport = {
    commitment: 'confirmed',
    async getAccountInfoAndContext(key: PublicKey,config?: { minContextSlot?: number }) { assertFloor(config); return { context: { slot: bank.slot },value: readAccount(key) }; },
    async getAccountInfo(key: PublicKey,config?: { minContextSlot?: number }) { assertFloor(config); return readAccount(key); },
    async getMultipleAccountsInfoAndContext(keys: PublicKey[],config?: { minContextSlot?: number }) { assertFloor(config); return { context: { slot: bank.slot },value: keys.map(readAccount) }; },
    async getMultipleAccountsInfo(keys: PublicKey[],config?: { minContextSlot?: number }) { assertFloor(config); return keys.map(readAccount); },
    async simulateTransaction(transaction: VersionedTransaction,config: { minContextSlot?: number; accounts?: { addresses: string[] } }) {
      if ((config.minContextSlot ?? 0)>bank.slot) throw new Error('Frozen preview bank is behind the read floor');
      const message = transaction.message,keys = message.staticAccountKeys;
      if (message.compiledInstructions.length>6 || (message.version===0 && message.addressTableLookups.length)) throw new Error('Invalid frozen preview transaction');
      for (const ix of message.compiledInstructions) {
        const owner = keys[ix.programIdIndex]?.toBase58();
        if (owner === ComputeBudgetProgram.programId.toBase58()) {
          const data = Buffer.from(ix.data);
          if (data.length!==5 || !((data[0]===1 && data.readUInt32LE(1)===256*1024)
            || (data[0]===2 && data.readUInt32LE(1)>0 && data.readUInt32LE(1)<=1_400_000)))
            throw new Error('Invalid frozen preview compute budget');
          continue;
        }
        if (owner !== programId || !discriminators.some(tag => Buffer.from(ix.data).subarray(0,tag.length).equals(Buffer.from(tag))))
          throw new Error('Frozen display transport only accepts approved read-only previews');
      }
      const result = svm.simulateTransaction(getTransactionDecoder().decode(transaction.serialize()));
      const failed = result instanceof FailedTransactionMetadata,meta = result.meta();
      let err: unknown = null;
      if (failed) {
        const failure = result.err() as unknown as { index?: number; err?: () => { code?: number } | number };
        const detail = failure.err?.();
        const reason = typeof detail === 'object' && detail?.code !== undefined ? { Custom: detail.code }
          : detail === InstructionErrorFieldless.ComputationalBudgetExceeded ? 'ComputationalBudgetExceeded'
          : detail === InstructionErrorFieldless.ProgramFailedToComplete ? 'ProgramFailedToComplete' : 'InvalidArgument';
        err = Number.isSafeInteger(failure.index) ? { InstructionError: [failure.index,reason] } : 'InvalidAccountData';
      }
      const posts = new Map(failed ? [] : result.postAccounts().map(row => [row.address,row]));
      const requested = config.accounts?.addresses ?? [];
      if (requested.length>32 || new Set(requested).size!==requested.length) throw new Error('Invalid frozen preview account request');
      const accounts = requested.map(key => {
        const post = posts.get(address(key)),original = bank.accounts.find(row => row.address===key)?.account;
        if (post) return { owner: post.programAddress,executable: post.executable,lamports: Number(post.lamports),data: [Buffer.from(post.data).toString('base64'),'base64'] };
        if (original) return { ...original,data: [original.data,'base64'] };
        const loaded = svm.getAccount(address(key));
        return loaded.exists ? { owner: loaded.programAddress,executable: loaded.executable,lamports: Number(loaded.lamports),data: [Buffer.from(loaded.data).toString('base64'),'base64'] } : null;
      });
      const returned = meta.returnData();
      return { context: { slot: bank.slot },value: { err,logs: meta.logs(),unitsConsumed: Number(meta.computeUnitsConsumed()),accounts,
        returnData: { programId: new PublicKey(returned.programId()).toBase58(),data: [Buffer.from(returned.data()).toString('base64'),'base64'] } } };
    },
  };
  return transport as unknown as Connection;
}
