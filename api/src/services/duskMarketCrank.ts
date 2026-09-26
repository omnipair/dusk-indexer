import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
import { Pool, PoolClient } from 'pg';
import { loadPinnedProtocol } from '../config/duskProtocol';

/** `observe_market`: refreshes a market and emits MarketObserved. */
const OBSERVE_MARKET = Buffer.from([165,112,165,82,197,36,150,191]);

export interface CrankMarket { market: string; ylpMint: string; baseHlpMint: string; quoteHlpMint: string; observedAt: Date | null }

/** Markets whose latest observation is older than `staleSeconds`, or that have
 * none, oldest first and capped per pass, as the v1 cranker caps update_pair. */
export async function staleObservedMarkets(client: Pool | PoolClient,staleSeconds: number,limit: number): Promise<CrankMarket[]> {
  const pin = loadPinnedProtocol();
  const result = await client.query<{ market: string; ylp_mint: string; base_hlp_mint: string; quote_hlp_mint: string; observed_at: Date | null }>(`
    SELECT m.market,m.ylp_mint,m.base_hlp_mint,m.quote_hlp_mint,o.time AS observed_at
    FROM dusk_ingestion.streamed_markets m
    LEFT JOIN dusk_ingestion.streamed_latest_market_observations o USING(cluster,program_id,idl_hash,protocol_revision,market)
    WHERE m.cluster=$1 AND m.program_id=$2 AND m.idl_hash=$3 AND m.protocol_revision=$4
      AND (o.time IS NULL OR o.time<now()-($5::int*interval '1 second'))
    ORDER BY o.time NULLS FIRST,m.market LIMIT $6`,
    [pin.cluster,pin.dusk.programId,pin.dusk.idlCanonicalSha256,pin.revision,staleSeconds,limit]);
  return result.rows.map((row) => ({ market: row.market,ylpMint: row.ylp_mint,baseHlpMint: row.base_hlp_mint,
    quoteHlpMint: row.quote_hlp_mint,observedAt: row.observed_at }));
}

export function observeMarketInstruction(market: CrankMarket,programId = new PublicKey(loadPinnedProtocol().dusk.programId)) {
  const address = new PublicKey(market.market),ylp = new PublicKey(market.ylpMint);
  const vault = (hlpMint: string) => PublicKey.findProgramAddressSync(
    [Buffer.from('hlp_ylp_vault'),address.toBuffer(),new PublicKey(hlpMint).toBuffer(),ylp.toBuffer()],programId)[0];
  const [eventAuthority] = PublicKey.findProgramAddressSync([Buffer.from('__event_authority')],programId);
  return new TransactionInstruction({ programId,data: OBSERVE_MARKET,keys: [
    { pubkey: address,isSigner: false,isWritable: true },
    { pubkey: ylp,isSigner: false,isWritable: false },
    { pubkey: vault(market.baseHlpMint),isSigner: false,isWritable: false },
    { pubkey: vault(market.quoteHlpMint),isSigner: false,isWritable: false },
    { pubkey: eventAuthority,isSigner: false,isWritable: false },
    { pubkey: programId,isSigner: false,isWritable: false },
  ] });
}

/** One crank pass. Without a payer it only reports what it would send. */
export async function crankStaleMarkets(options: {
  pool: Pool; staleSeconds: number; limit: number; connection?: Connection; payer?: Keypair;
}) {
  const due = await staleObservedMarkets(options.pool,options.staleSeconds,options.limit);
  const results: Array<{ market: string; signature: string | null; error?: string }> = [];
  for (const market of due) {
    if (!options.connection || !options.payer) { results.push({ market: market.market,signature: null }); continue; }
    try {
      const transaction = new Transaction().add(observeMarketInstruction(market));
      const signature = await options.connection.sendTransaction(transaction,[options.payer],{ preflightCommitment: 'confirmed' });
      results.push({ market: market.market,signature });
    } catch (error) {
      // One market's failure never stops the pass; it stays stale and is retried.
      results.push({ market: market.market,signature: null,error: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}
