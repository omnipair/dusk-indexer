import { PublicKey, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import type { TransactionInstruction } from '@solana/web3.js';

/** Capture auxiliary accounts in the same simulated bank without passing them
 * to a program instruction. Existing instruction privileges stay unchanged. */
export function snapshotTransaction(payer: PublicKey, instructions: TransactionInstruction[], addresses: string[]) {
  const message = new TransactionMessage({payerKey:payer,recentBlockhash:PublicKey.default.toBase58(),instructions}).compileToV0Message();
  const auxiliary = [...new Set(addresses)].map(address=>new PublicKey(address))
    .filter(key=>!message.staticAccountKeys.some(existing=>existing.equals(key)));
  message.staticAccountKeys.push(...auxiliary);
  message.header.numReadonlyUnsignedAccounts += auxiliary.length;
  const transaction = new VersionedTransaction(message);
  if (transaction.serialize().length>1232) throw new Error('Snapshot exceeds the transaction packet limit');
  return transaction;
}
