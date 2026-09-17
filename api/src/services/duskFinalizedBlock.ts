interface FinalizedBlock {
  blockhash: string;
  parentSlot: number;
  blockTime: number | null;
}
interface BlockReader {
  getBlock(slot: number, config: {
    commitment: 'finalized' | 'confirmed'; transactionDetails: 'none'; rewards: false; maxSupportedTransactionVersion: 0;
  }): Promise<FinalizedBlock | null>;
}

/** Account banks can reach finality before the provider's block-history replica. */
export async function readFinalizedBlock(
  rpc: BlockReader,
  slot: number,
  pause: (milliseconds: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve,ms)),
) {
  return readBlockAtCommitment(rpc,slot,'finalized',pause);
}

/** Live previews use confirmed banks; historical captures remain finalized. */
export async function readConfirmedBlock(rpc: BlockReader,slot: number,
  pause: (milliseconds: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve,ms))) {
  return readBlockAtCommitment(rpc,slot,'confirmed',pause);
}

async function readBlockAtCommitment(rpc: BlockReader,slot: number,commitment: 'finalized' | 'confirmed',pause: (milliseconds: number) => Promise<void>) {
  if (!Number.isSafeInteger(slot) || slot<0) throw new Error('Invalid finalized source slot');
  for (let attempt = 0; ; attempt++) {
    try {
      // Always retry this exact bank. A newer block cannot timestamp its bytes.
      const block = await rpc.getBlock(slot,{ commitment,transactionDetails: 'none',rewards: false,maxSupportedTransactionVersion: 0 });
      if (!block || block.blockTime === null || !Number.isSafeInteger(block.blockTime))
        throw new Error('Finalized source block/time is unavailable');
      return { ...block,blockTime: block.blockTime };
    } catch (error) {
      if (attempt>=3) throw error;
      await pause(500*(attempt+1));
    }
  }
}
