import { AnchorProvider, BorshCoder, Idl, Program, Wallet } from '@coral-xyz/anchor';
import { ComputeBudgetProgram, Connection, PublicKey, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { duskApiConfig, loadPinnedProtocol } from '../config/duskProtocol';
import { deploymentEnvelope } from './duskDeploymentService';
import { readConfirmedBlock, readFinalizedBlock } from './duskFinalizedBlock';
import { priceMarketBindings } from './duskPriceMath';

export interface SnapshotAccount { owner: string; executable: boolean; data: string }
export interface MarketSimulationSnapshot {
  /** Absent only on older saved finalized captures. */
  commitment?: 'finalized';
  market: string; slot: number; blockhash: string; blockTime: string; observedAt: string;
  deploymentIdentitySha256: string; marketAccount: SnapshotAccount;
  preview: string | null; accounts: { address: string; account: SnapshotAccount | null }[];
  basis: 'simulation-post-state' | 'rpc-account'; previewUnavailable: boolean;
}
export type LiveMarketSimulationSnapshot = Omit<MarketSimulationSnapshot,'commitment'> & { commitment: 'confirmed' };
interface SimulationDependencies {
  rpc: Connection; envelope: typeof deploymentEnvelope; readBlock: typeof readFinalizedBlock; pause?: (milliseconds: number) => Promise<void>;
}
export function duskRawIdl(): Idl {
  loadPinnedProtocol();
  return JSON.parse(readFileSync(resolve(process.env.DUSK_PROTOCOL_DIR?.trim() || resolve(__dirname,'../../../protocol'),'idl/dusk.json'),'utf8')) as Idl;
}
function serializedAccount(value: { owner: string; executable: boolean; data: string[] } | null): SnapshotAccount | null {
  if (!value) return null;
  if (value.data.length !== 2 || value.data[1] !== 'base64' || Buffer.from(value.data[0],'base64').toString('base64') !== value.data[0]) throw new Error('Invalid simulated account encoding');
  return { owner: value.owner,executable: value.executable,data: value.data[0] };
}

/** Extra read-only accounts are returned at the preview's bank, in requested order. */
export async function captureMarketSimulation(market: string, minSlot: number, extraAddresses: string[] = [], dependencies?: SimulationDependencies): Promise<MarketSimulationSnapshot> {
  return captureAtCommitment(market,minSlot,extraAddresses,'finalized',dependencies);
}
export async function captureLiveMarketSimulation(market: string, minSlot: number, extraAddresses: string[] = [], dependencies?: SimulationDependencies): Promise<LiveMarketSimulationSnapshot> {
  return captureAtCommitment(market,minSlot,extraAddresses,'confirmed',dependencies);
}
async function captureAtCommitment<C extends 'finalized' | 'confirmed'>(market: string,minSlot: number,extraAddresses: string[],commitment: C,
  dependencies?: SimulationDependencies): Promise<Omit<MarketSimulationSnapshot,'commitment'> & { commitment: C }> {
  if (!Number.isSafeInteger(minSlot) || minSlot<0 || extraAddresses.length>20 || new Set([market,...extraAddresses]).size !== extraAddresses.length+1)
    throw new Error('Invalid bounded market snapshot request');
  const pin = loadPinnedProtocol(),rpc = dependencies?.rpc ?? new Connection(duskApiConfig().rpcUrl,commitment),rawIdl = duskRawIdl();
  const envelope = dependencies?.envelope ?? deploymentEnvelope,readBlock = dependencies?.readBlock ?? (commitment === 'finalized' ? readFinalizedBlock : readConfirmedBlock);
  const pause = dependencies?.pause ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve,ms)));
  async function atMinimumSlot<T>(read: () => Promise<T>): Promise<T> {
    for (let attempt=0; ; attempt++) {
      try { return await read(); }
      catch (error) {
        if (attempt>=3 || !(error instanceof Error) || !error.message.includes('Minimum context slot has not been reached')) throw error;
        await pause(500*(attempt+1));
      }
    }
  }
  const program = new Program(rawIdl,new AnchorProvider(rpc,{} as Wallet,{ commitment }));
  const before = await envelope(minSlot,{ fresh: true });
  const payer = process.env.DUSK_PREVIEW_PAYER?.trim() || before.programUpgradeAuthority;
  if (!payer) throw new Error('A read-only preview payer must be configured');
  const instruction = await program.methods.previewMarket().accounts({ market: new PublicKey(market) })
    .remainingAccounts(extraAddresses.map((address) => ({ pubkey: new PublicKey(address),isSigner: false,isWritable: false }))).instruction();
  const requested = [market,...extraAddresses];
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: new PublicKey(payer),recentBlockhash: PublicKey.default.toBase58(),
    instructions: [ComputeBudgetProgram.requestHeapFrame({ bytes: 256*1024 }),ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),instruction],
  }).compileToV0Message());
  if (tx.serialize().length>1232) throw new Error('Market snapshot exceeds the transaction packet limit');
  const simulation = await atMinimumSlot(() => rpc.simulateTransaction(tx,{ commitment,minContextSlot: minSlot,replaceRecentBlockhash: true,sigVerify: false,
    accounts: { encoding: 'base64',addresses: requested } }));
  let slot = simulation.context.slot,preview: string | null = null,basis: MarketSimulationSnapshot['basis'] = 'simulation-post-state';
  if (!Number.isSafeInteger(slot) || slot<minSlot) throw new Error('Regressed market simulation slot');
  let accounts: (SnapshotAccount | null)[];
  if (simulation.value.err) {
    // Preserve ownership/position visibility when this market cannot preview.
    // Its valuation stays unavailable; no failed simulation state is accepted.
    const fallbackFloor = Math.max(minSlot,slot);
    const read = await atMinimumSlot(() => rpc.getMultipleAccountsInfoAndContext(requested.map((address) => new PublicKey(address)),{ commitment,minContextSlot: fallbackFloor }));
    slot = read.context.slot; basis = 'rpc-account';
    accounts = read.value.map((account) => account ? { owner: account.owner.toBase58(),executable: account.executable,data: account.data.toString('base64') } : null);
  } else {
    const returned = simulation.value.returnData;
    if (!returned || returned.programId !== pin.dusk.programId || returned.data.length !== 2 || returned.data[1] !== 'base64'
      || !returned.data[0] || Buffer.from(returned.data[0],'base64').toString('base64') !== returned.data[0] || !simulation.value.accounts)
      throw new Error('Market simulation returned no matching program/account data');
    preview = returned.data[0];
    accounts = simulation.value.accounts.map(serializedAccount);
  }
  if (!Number.isSafeInteger(slot) || slot<minSlot || accounts.length !== requested.length) throw new Error('Incomplete or regressed market snapshot');
  const marketAccount = accounts[0];
  if (!marketAccount || marketAccount.owner !== pin.dusk.programId || marketAccount.executable) throw new Error('Market snapshot has an invalid owner');
  const decoder = new BorshCoder(rawIdl);
  priceMarketBindings(pin.dusk.programId,market,decoder.accounts.decode('Market',Buffer.from(marketAccount.data,'base64')));
  if (preview && String((decoder.types.decode('MarketPreview',Buffer.from(preview,'base64')) as { slot: unknown }).slot) !== String(slot))
    throw new Error('Market preview and account snapshot slots differ');
  // The timestamp belongs to this already-captured bank. Fetching it does not
  // depend on the final deployment check, but both must pass before returning.
  const [after,block] = await Promise.all([envelope(slot,{ fresh: true }),readBlock(rpc,slot)]);
  if (before.deploymentIdentitySha256 !== after.deploymentIdentitySha256) throw new Error('Deployment changed during market snapshot');
  return { commitment,market,slot,blockhash: block.blockhash,blockTime: new Date(block.blockTime*1000).toISOString(),observedAt: new Date().toISOString(),
    deploymentIdentitySha256: after.deploymentIdentitySha256,marketAccount,preview,basis,previewUnavailable: preview === null,
    accounts: extraAddresses.map((address,index) => ({ address,account: accounts[index+1] })) };
}
