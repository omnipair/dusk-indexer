/** Optional devnet test worker. Its key can only update its own synthetic feed;
 * the deployment wallet is never present in this service. No external price claim. */
import { setTimeout } from 'node:timers/promises';
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } from '@solana/web3.js';
import { duskApiConfig } from '../config/duskProtocol';
import mock from '../config/oracles/devnet-mock.json';
import { decodeMockReport } from './duskOracleCatalog';

export async function runDevnetMockPublisher(signal: AbortSignal) {
  if (process.env.DUSK_DEVNET_MOCK_ORACLE_ENABLED !== 'true') return;
  const config = duskApiConfig();
  if (config.network !== 'devnet') throw new Error('Mock oracle requires devnet');
  const connection = new Connection(config.rpcUrl, 'confirmed');
  if (await connection.getGenesisHash() !== 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG') throw new Error('Mock oracle cluster mismatch');
  const secret = JSON.parse(process.env.DUSK_DEVNET_MOCK_ORACLE_SECRET ?? 'null');
  if (!Array.isArray(secret) || secret.length !== 64 || !secret.every(b => Number.isInteger(b) && b >= 0 && b <= 255)) throw new Error('Mock publisher key unavailable');
  const signer = Keypair.fromSecretKey(Uint8Array.from(secret));
  if (signer.publicKey.toBase58() !== mock.publisher) throw new Error('Wrong mock publisher');
  const programId = new PublicKey(mock.programId), reportKey = new PublicKey(mock.report);
  const [expected] = PublicKey.findProgramAddressSync([Buffer.from('mock-feed'), signer.publicKey.toBuffer(), Buffer.from(mock.feedId, 'hex')], programId);
  if (!expected.equals(reportKey)) throw new Error('Mock PDA mismatch');
  while (!signal.aborted) {
    try {
      const account = await connection.getAccountInfo(reportKey, 'confirmed');
      if (!account) throw new Error('Initialize the test feed before starting the publisher');
      // Authenticate pair identity without imposing age: the purpose is to refresh it.
      decodeMockReport(account.data, account.owner.toBase58(), { slot: (1n << 64n) - 1n, unix: (1n << 63n) - 1n });
      if (account.data[144] === 1) {
        const data = Buffer.alloc(121);
        account.data.copy(data, 0, 8, 120); data[112] = 1;
        data.writeBigUInt64LE(account.data.readBigUInt64LE(136), 113);
        const tx = new Transaction().add(new TransactionInstruction({ programId, data, keys: [
          { pubkey: signer.publicKey, isSigner: true, isWritable: true },
          { pubkey: reportKey, isSigner: false, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ] }));
        const signature = await sendAndConfirmTransaction(connection, tx, [signer], { commitment: 'confirmed' });
        console.log('Refreshed synthetic devnet oracle', { report: mock.report, signature });
      }
      // Invalidated reports stay invalid. Only the publisher's CLI resumes them.
    } catch { console.warn('Synthetic devnet oracle refresh unavailable'); }
    try { await setTimeout(mock.updateIntervalSeconds * 1000, undefined, { signal }); }
    catch { break; }
  }
}
