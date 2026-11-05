/** Optional devnet test worker. Its key can only update its own synthetic feed;
 * the deployment wallet is never present in this service. No external price claim. */
import { setTimeout } from 'node:timers/promises';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SendTransactionError, SystemProgram, Transaction, TransactionInstruction,
  sendAndConfirmTransaction } from '@solana/web3.js';
import { duskApiConfig } from '../config/duskProtocol';
import mock from '../config/oracles/devnet-mock.json';
import { decodeMockReport } from './duskOracleCatalog';

/** The refresh carries one signature and no priority fee. */
export const REFRESH_FEE_LAMPORTS = 5000;
/** Below this runway the worker warns, at most once per reminder interval. */
export const LOW_RUNWAY_SECONDS = 7 * 24 * 60 * 60;
const REMINDER_INTERVAL_MS = 60 * 60 * 1000;

export type RefreshFailureReason = 'publisher-out-of-funds' | 'rpc-rate-limited' | 'rpc-unreachable' | 'transaction-expired'
  | 'transaction-rejected' | 'unexpected';
export class PublisherOutOfFundsError extends Error {}

/** A fee payer must stay rent exempt after paying, so only lamports above the floor buy refreshes. */
export function publisherRunway(balanceLamports: number, rentFloorLamports: number, intervalSeconds = mock.updateIntervalSeconds) {
  const refreshes = Math.max(0, Math.floor((balanceLamports - rentFloorLamports) / REFRESH_FEE_LAMPORTS));
  return { refreshes, seconds: refreshes * intervalSeconds };
}

/** RPC errors can quote the endpoint, whose path or query holds the provider key. */
export function redactRpcSecrets(text: string, rpcUrl: string): string {
  const secrets = [rpcUrl];
  try {
    const url = new URL(rpcUrl);
    secrets.push(url.username, url.password, ...url.searchParams.values(), ...url.pathname.split('/'));
  } catch { /* Not a URL: the literal value is still redacted. */ }
  let redacted = text;
  for (const secret of secrets) if (secret.length >= 8) redacted = redacted.split(secret).join('<redacted>');
  return redacted.replace(/\b(?:https?|wss?):\/\/\S+/gi, '<url>').replace(/(api[-_]?key=)[^&\s"']+/gi, '$1<redacted>').slice(0, 400);
}

/** Names why a refresh failed. Program logs are public chain data; everything else is redacted. */
export function describeRefreshFailure(error: unknown, rpcUrl: string): { reason: RefreshFailureReason; detail: string } {
  const message = error instanceof Error ? error.message : String(error);
  const logs = error instanceof SendTransactionError ? error.logs ?? [] : [];
  const text = [message, ...logs].join('\n');
  const reason: RefreshFailureReason = error instanceof PublisherOutOfFundsError
    || /insufficient funds|insufficient lamports|no record of a prior credit/i.test(text) ? 'publisher-out-of-funds'
    : /\b429\b|too many requests/i.test(text) ? 'rpc-rate-limited'
    : /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up/i.test(text) ? 'rpc-unreachable'
    : /block height exceeded|was not confirmed in/i.test(text) ? 'transaction-expired'
    : error instanceof SendTransactionError || /custom program error|simulation failed/i.test(text) ? 'transaction-rejected'
    : 'unexpected';
  return { reason, detail: redactRpcSecrets([message, ...logs.slice(-3)].join(' | '), rpcUrl) };
}

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
  let rentFloor: number | null = null, lowBalanceWarnedAt = 0, invalidWarnedAt = 0;
  while (!signal.aborted) {
    try {
      // One read returns the report and the fee payer's balance.
      const [account, payer] = await connection.getMultipleAccountsInfo([reportKey, signer.publicKey], 'confirmed');
      if (!account) throw new Error('Initialize the test feed before starting the publisher');
      // Authenticate pair identity without imposing age: the purpose is to refresh it.
      decodeMockReport(account.data, account.owner.toBase58(), { slot: (1n << 64n) - 1n, unix: (1n << 63n) - 1n });
      if (account.data[144] === 1) {
        rentFloor ??= await connection.getMinimumBalanceForRentExemption(0, 'confirmed');
        const balance = payer?.lamports ?? 0, runway = publisherRunway(balance, rentFloor);
        if (runway.refreshes === 0) throw new PublisherOutOfFundsError(
          `Publisher ${mock.publisher} holds ${balance} lamports; a refresh needs at least ${rentFloor + REFRESH_FEE_LAMPORTS}`);
        if (runway.seconds < LOW_RUNWAY_SECONDS && Date.now() - lowBalanceWarnedAt >= REMINDER_INTERVAL_MS) {
          lowBalanceWarnedAt = Date.now();
          console.warn('Synthetic devnet oracle publisher balance is low', { publisher: mock.publisher,
            balanceSol: balance / LAMPORTS_PER_SOL, runwayHours: Math.floor(runway.seconds / 3600) });
        }
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
      } else if (Date.now() - invalidWarnedAt >= REMINDER_INTERVAL_MS) {
        // Invalidated reports stay invalid. Only the publisher's CLI resumes them.
        invalidWarnedAt = Date.now();
        console.warn('Synthetic devnet oracle report is invalidated; only the publisher CLI resumes it', { report: mock.report });
      }
    } catch (error) { console.warn('Synthetic devnet oracle refresh unavailable', describeRefreshFailure(error, config.rpcUrl)); }
    try { await setTimeout(mock.updateIntervalSeconds * 1000, undefined, { signal }); }
    catch { break; }
  }
}
