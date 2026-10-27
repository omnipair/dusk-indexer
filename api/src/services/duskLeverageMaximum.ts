/** One bank capture, local native search, then a caller-side fresh execution check. */
import { Connection, ComputeBudgetProgram, PublicKey, SYSVAR_CLOCK_PUBKEY, SYSVAR_RENT_PUBKEY, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { createHash } from 'node:crypto';
import { fork } from 'node:child_process';
import { resolve } from 'node:path';
import { duskApiConfig } from '../config/duskProtocol';
import { deploymentEnvelope } from './duskDeploymentService';
import { duskRawIdl } from './duskMarketSimulation';
import { FrozenLeverageBank, LeverageMaximumInput, parseLeverageMaximumInput, quoteRuntimeBytes } from './duskLeverageMaximumInput';

const UPGRADEABLE = 'BPFLoaderUpgradeab1e11111111111111111111111';
let inFlight = 0;
const fail = (message: string,status = 503) => Object.assign(new Error(message),{ status });
// Program-data addresses are metadata only. Every account byte is captured anew.
const executableAddresses = new Map<string,string>();
const digest = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');

/** A distinct payer keeps the requested owner's balance unchanged by capture fees. */
export async function captureLeverageQuoteBank(input: LeverageMaximumInput, keys: PublicKey[], payer: string, rpc: Connection): Promise<FrozenLeverageBank> {
  const unique = new Map(keys.map((key) => [key.toBase58(),key]));
  unique.set(SYSVAR_CLOCK_PUBKEY.toBase58(),SYSVAR_CLOCK_PUBKEY);
  unique.set(SYSVAR_RENT_PUBKEY.toBase58(),SYSVAR_RENT_PUBKEY);
  const addresses = [...unique.values()];
  if (addresses.length > 96) throw fail('Quote account limit exceeded',400);
  // The preview payer may itself trade. In that case use a read-only batch,
  // accepting it only when its Clock actually belongs to the returned bank.
  const batch = payer === input.owner || addresses.length > 32;
  for (let attempt = 0; attempt < (batch ? 3 : 1); attempt++) {
    let slot: number, values: FrozenLeverageBank['accounts'];
    if (batch) {
      const result = await rpc.getMultipleAccountsInfoAndContext(addresses,{ commitment: 'confirmed',minContextSlot: input.minimumSourceSlot });
      slot = result.context.slot;
      values = result.value.map((a,index) => ({ address: addresses[index].toBase58(),account: a ? {
        ...a,owner: a.owner.toBase58(),data: a.data.toString('base64'),rentEpoch: normalizeEpoch(a.rentEpoch),
      } : null }));
    } else {
      const instruction = ComputeBudgetProgram.setComputeUnitLimit({ units: 1000 });
      instruction.keys = addresses.map((pubkey) => ({ pubkey,isSigner: false,isWritable: false }));
      const transaction = new VersionedTransaction(new TransactionMessage({ payerKey: new PublicKey(payer),recentBlockhash: PublicKey.default.toBase58(),instructions: [instruction] }).compileToV0Message());
      const result = await rpc.simulateTransaction(transaction,{ commitment: 'confirmed',replaceRecentBlockhash: true,sigVerify: false,minContextSlot: input.minimumSourceSlot,
        accounts: { encoding: 'base64',addresses: addresses.map((key) => key.toBase58()) } });
      if (result.value.err || !result.value.accounts) throw fail('Native quote bank unavailable');
      slot = result.context.slot;
      values = result.value.accounts.map((a,index) => {
        if (!a) return { address: addresses[index].toBase58(),account: null };
        if (a.data[1] !== 'base64') throw fail('Invalid quote account encoding');
        return { address: addresses[index].toBase58(),account: { ...a,data: a.data[0],rentEpoch: normalizeEpoch((a as typeof a & { rentEpoch?: number }).rentEpoch) } };
      });
    }
    if (!Number.isSafeInteger(slot) || slot < input.minimumSourceSlot || values.length !== addresses.length) throw fail('Native quote bank unavailable');
    for (const row of values) {
      const a = row.account;
      if (a && (!Number.isSafeInteger(a.lamports) || a.lamports < 0 || Buffer.from(a.data,'base64').toString('base64') !== a.data)) throw fail('Invalid quote snapshot account');
    }
    const clock = values.find((row) => row.address === SYSVAR_CLOCK_PUBKEY.toBase58())?.account;
    if (clock && clock.owner === 'Sysvar1111111111111111111111111111111111111' && Buffer.from(clock.data,'base64').length === 40
      && Buffer.from(clock.data,'base64').readBigUInt64LE(0) === BigInt(slot)) return { slot,accounts: values };
  }
  throw fail('Quote snapshot clock mismatch');
}
function normalizeEpoch(epoch: number | undefined): string {
  if (epoch === Number((1n<<64n)-1n)) return String((1n<<64n)-1n);
  if (epoch !== undefined && (!Number.isSafeInteger(epoch) || epoch < 0)) throw fail('Invalid quote snapshot epoch');
  return String(epoch ?? 0);
}

/** Bound response memory as well as time; no account payload is retained globally. */
export const quoteRpcFetch: typeof fetch = async (url,init) => {
  const response = await fetch(url,init);
  const reader = response.body?.getReader();
  if (!reader) return response;
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      bytes += next.value.length;
      if (bytes > 24*1024*1024) throw fail('Quote account payload limit exceeded');
      chunks.push(next.value);
    }
  } finally { await reader.cancel(); }
  const headers = new Headers(response.headers); headers.delete('content-encoding'); headers.delete('content-length');
  return new Response(Buffer.concat(chunks),{ status: response.status,statusText: response.statusText,headers });
};

export async function currentLeverageMaximum(body: unknown, signal?: AbortSignal) {
  const idl = duskRawIdl();
  let input: LeverageMaximumInput,transaction: VersionedTransaction;
  try { const decoded = parseLeverageMaximumInput(body,idl); input = decoded.input; transaction = decoded.parsed.transaction; }
  catch { throw fail('Invalid leverage maximum input',400); }
  if (inFlight >= 4) throw fail('Quote service busy; try again',429);
  inFlight++;
  const started = performance.now();
  try {
    signal?.throwIfAborted();
    const before = await deploymentEnvelope(input.minimumSourceSlot);
    if (before.deploymentIdentitySha256 !== input.deploymentIdentitySha256) throw fail('Quote deployment changed',409);
    quoteRuntimeBytes(before.programId,before.programBinarySha256);
    const rpc = new Connection(duskApiConfig().rpcUrl,{ commitment: 'confirmed',disableRetryOnRateLimit: true,
      fetch: (url,init) => quoteRpcFetch(url,{ ...init,signal: AbortSignal.any([AbortSignal.timeout(12000),...(signal ? [signal] : [])]) }) });
    const payer = [process.env.DUSK_PREVIEW_PAYER?.trim(),before.programUpgradeAuthority].find((key) => key && key !== input.owner);
    const capturePayer = payer ?? input.owner;
    const keys = transaction.message.staticAccountKeys;
    const known = keys.flatMap((key) => { const address = executableAddresses.get(key.toBase58()); return address ? [new PublicKey(address)] : []; });
    const captureStarted = performance.now();
    let bank = await captureLeverageQuoteBank(input,[...keys,...known],capturePayer,rpc);
    // Upgradeable CPI executables are captured with their program-data accounts
    // in a second complete bank, never grafted from a different observation.
    const extra = bank.accounts.flatMap((row) => {
      const a = row.account;
      if (!a?.executable || row.address === before.programId || a.owner !== UPGRADEABLE) return [];
      const bytes = Buffer.from(a.data,'base64');
      if (bytes.length !== 36 || bytes.readUInt32LE(0) !== 2) throw fail('Invalid quote CPI program');
      const address = new PublicKey(bytes.subarray(4));
      executableAddresses.set(row.address,address.toBase58());
      if (executableAddresses.size > 128) executableAddresses.delete(executableAddresses.keys().next().value!);
      return bank.accounts.some((a) => a.address === address.toBase58()) ? [] : [address];
    });
    if (extra.length) bank = await captureLeverageQuoteBank({ ...input,minimumSourceSlot: bank.slot },[...keys,...known,...extra],capturePayer,rpc);
    const captureMs = performance.now()-captureStarted;
    const result = await runLeverageMaximumProcess(input,bank,idl,before.programId,before.programBinarySha256,signal);
    signal?.throwIfAborted();
    if (result.kind !== 'maximum' && result.kind !== 'capacity') throw fail('Native quote unavailable');
    const after = await deploymentEnvelope(bank.slot);
    if (after.deploymentIdentitySha256 !== before.deploymentIdentitySha256) throw fail('Quote deployment changed',409);
    return { schemaVersion: 'dusk-leverage-maximum.v1',deployment: after,data: { ...result,captureMs,sourceSlot: bank.slot,transactionSha256: digest(transaction.serialize()),elapsedMs: performance.now()-started } };
  } finally { inFlight--; }
}

/** Isolated non-signing native evaluator, bounded by both caller cancellation and timeout. */
export function runLeverageMaximumProcess(input: LeverageMaximumInput,bank: FrozenLeverageBank,idl: ReturnType<typeof duskRawIdl>,programId: string,binarySha256: string,signal?: AbortSignal): Promise<Record<string,unknown>> {
  signal?.throwIfAborted();
  return new Promise<Record<string,unknown>>((resolveResult,reject) => {
      // A separate process also contains native-runtime exits; the API stays live.
      const worker = fork(resolve(__dirname,'duskLeverageMaximumProcess.js'),[],{ stdio: ['ignore','ignore','ignore','ipc'],execArgv: ['--max-old-space-size=256'] });
      let settled = false;
      const finish = (error?: Error,value?: Record<string,unknown>) => {
        if (settled) return; settled = true; cleanup(); worker.kill('SIGKILL');
        if (error) reject(error); else resolveResult(value!);
      };
      const timer = setTimeout(() => finish(fail('Native quote timed out')),10000);
      const abort = () => finish(fail('Quote cancelled',499));
      signal?.addEventListener('abort',abort,{ once: true });
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort',abort); };
      worker.once('message',(value: Record<string,unknown>) => finish(undefined,value));
      worker.once('error',(error) => finish(error));
      worker.once('exit',(code,signal) => { if (!settled) console.error('Native leverage evaluator stopped',{ code,signal }); finish(fail('Native quote worker stopped')); });
      worker.send({ input,bank,idl,programId: programId,binarySha256: binarySha256 },(error) => { if (error) finish(error); });
      if (signal?.aborted) abort();
    });
}
