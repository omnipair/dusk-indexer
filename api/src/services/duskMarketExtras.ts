import { getMetadataAccountDataSerializer, Key } from '@metaplex-foundation/mpl-token-metadata';
import { ExtensionType, getExtensionData, TOKEN_2022_PROGRAM_ID, unpackAccount, unpackMint } from '@solana/spl-token';
import { unpack } from '@solana/spl-token-metadata';
import { PublicKey } from '@solana/web3.js';
import type { LiveMarketSimulationSnapshot, SnapshotAccount } from './duskMarketSimulation';
import { loadPinnedProtocol } from '../config/duskProtocol';

const METADATA_PROGRAM = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
export function tokenMetadataAddress(mint: string): string {
  return PublicKey.findProgramAddressSync([Buffer.from('metadata'),METADATA_PROGRAM.toBuffer(),new PublicKey(mint).toBuffer()],METADATA_PROGRAM)[0].toBase58();
}
export function leverageCollateralAddress(market: string, mint: string): string {
  return PublicKey.findProgramAddressSync([Buffer.from('leverage_collateral'),new PublicKey(market).toBuffer(),new PublicKey(mint).toBuffer()],new PublicKey(loadPinnedProtocol().dusk.programId))[0].toBase58();
}
function accountInfo(account: SnapshotAccount) {
  return { owner: new PublicKey(account.owner),executable: account.executable,data: Buffer.from(account.data,'base64'),lamports: 0 };
}
function displayLabel(value: string, limit: number): string | null {
  const text = value.replace(/\0+$/g,'').trim();
  return text.length>0 && text.length<=limit && !/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(text) ? text : null;
}

/** Cosmetic metadata is optional; it cannot supply decimals, prices or mint identity. */
export function snapshotTokenMetadata(snapshot: LiveMarketSimulationSnapshot, mint: string) {
  try {
    const rawMint = snapshot.accounts.find((entry) => entry.address === mint)?.account;
    if (!rawMint) return null;
    let label: { name: string; symbol: string; mint: { toString(): string } } | undefined;
    let source: 'token-2022' | 'metaplex' = 'token-2022',address = mint;
    if (rawMint.owner === TOKEN_2022_PROGRAM_ID.toBase58()) {
      const decoded = unpackMint(new PublicKey(mint),accountInfo(rawMint),TOKEN_2022_PROGRAM_ID);
      const data = getExtensionData(ExtensionType.TokenMetadata,decoded.tlvData);
      if (data) label = unpack(data);
    }
    if (!label) {
      source = 'metaplex'; address = tokenMetadataAddress(mint);
      const account = snapshot.accounts.find((entry) => entry.address === address)?.account;
      if (!account || account.executable || account.owner !== METADATA_PROGRAM.toBase58()) return null;
      const [metadata] = getMetadataAccountDataSerializer().deserialize(Buffer.from(account.data,'base64'));
      if (metadata.key !== Key.MetadataV1) return null;
      label = metadata;
    }
    if (label.mint.toString() !== mint) return null;
    const symbol = displayLabel(label.symbol,32),name = displayLabel(label.name,128);
    return symbol && name ? { mint,symbol,name,source,address } : null;
  } catch {
    // A malformed optional label must not remove its market from discovery.
    return null;
  }
}

/** Collateral balances and reserve ledgers come from the same simulation bank. */
export function snapshotCollateralAmount(snapshot: LiveMarketSimulationSnapshot, vault: string, mint: string, tokenProgram: string, optional = false): string {
  const entry = snapshot.accounts.find((entry) => entry.address === vault),account = entry?.account;
  // Leverage custody is created lazily. An explicitly observed absent PDA holds zero.
  if (optional && entry && (account === null || account !== undefined &&
    account.owner === PublicKey.default.toBase58() && !account.executable && account.data === '')) return '0';
  if (!account || account.executable || account.owner !== tokenProgram) throw new Error(`Market snapshot omits a valid collateral vault: ${vault} (${account?.owner ?? 'absent'})`);
  const decoded = unpackAccount(new PublicKey(vault),accountInfo(account),new PublicKey(tokenProgram));
  if (!decoded.isInitialized || !decoded.mint.equals(new PublicKey(mint)) || !decoded.owner.equals(new PublicKey(snapshot.market)))
    throw new Error('Collateral vault mint or market authority mismatch');
  return decoded.amount.toString();
}
