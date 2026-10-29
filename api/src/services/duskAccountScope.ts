import { utils } from '@coral-xyz/anchor';
import { MARKET_LAYOUT_VERSION, type Dusk } from '@omnipair/dusk-sdk';
import { PublicKey } from '@solana/web3.js';
import { boundedDuskRpcRead } from './virtualBook/native';

/** Discover only markets supported by this release. Positions belonging to
 * removed devnet markets must never enter the current account decoder. */
export async function currentAccountMarkets(dusk: Dusk, minContextSlot: number, signal?: AbortSignal) {
  const discriminator = dusk.program.coder.accounts.memcmp('market');
  const prefix = Buffer.from(utils.bytes.bs58.decode(discriminator.bytes));
  const result = await boundedDuskRpcRead(() => dusk.program.provider.connection.getProgramAccounts(
    dusk.program.programId, {
      commitment: 'confirmed', withContext: true, minContextSlot,
      dataSlice: { offset: 0, length: 9 },
      filters: [{ memcmp: discriminator }, { memcmp: {
        offset: 8, bytes: utils.bytes.bs58.encode(Buffer.from([MARKET_LAYOUT_VERSION])),
      } }],
    },
  ), signal);
  if (!Number.isSafeInteger(result.context.slot) || result.context.slot < minContextSlot)
    throw new Error('Market scope is behind confirmed state');
  const markets = new Set<string>();
  for (const {pubkey, account} of result.value) {
    const address = pubkey.toBase58();
    if (markets.has(address) || account.executable || !account.owner.equals(dusk.program.programId) ||
      account.data.length !== 9 || !account.data.subarray(0,8).equals(prefix) || account.data[8] !== MARKET_LAYOUT_VERSION)
      throw new Error('Invalid current market scope');
    markets.add(address);
  }
  return { markets, sourceSlot: result.context.slot };
}

/** All current wallet account types start with discriminator, owner and market.
 * Read only this identity prefix before attempting the current Borsh layout. */
export function currentAccountMarket(data: Buffer, markets: ReadonlySet<string>): boolean {
  if (data.length < 72) throw new Error('Invalid account identity prefix');
  return markets.has(new PublicKey(data.subarray(40,72)).toBase58());
}
