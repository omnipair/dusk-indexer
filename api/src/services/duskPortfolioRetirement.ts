/** Terminal withdrawals from the actual helper's finalized canonical events.
 * Historical positions keep their original identity and stored valuations.
 * No local economic-model operation is a real swap, repayment or yield claim.
 */
import type { PoolClient } from 'pg';
import type { DuskPinnedProtocol } from '../config/duskProtocol';
import { checkedPortfolioHistoryRevisions,portfolioRevisionIdentity } from './duskPortfolioHistoryRevisions';
import { loadPinnedProtocol } from '../config/duskProtocol';
import { nativeKey } from './duskPortfolioMath';

export async function readPortfolioRetirementWithdrawals(client:PoolClient,options:{owner:string;since?:string;until?:string},pins:readonly DuskPinnedProtocol[]){
  const revisions=checkedPortfolioHistoryRevisions(loadPinnedProtocol(),pins),values:unknown[]=[nativeKey(options.owner)];
  const identities=revisions.map(pin=>{
    const offset=values.length;values.push(...portfolioRevisionIdentity(pin));
    return `(cluster=$${offset+1} AND program_id=$${offset+2} AND legacy_idl_hash=$${offset+3} AND legacy_protocol_revision=$${offset+4})`;
  });
  const filters=[`(${identities.join(' OR ')})`,'owner=$1','NOT treasury'];
  for(const [field,operator] of [['since','>='],['until','<=']] as const)if(options[field]){
    values.push(new Date(options[field]!).toISOString());filters.push(`block_time${operator}$${values.length}`);
  }
  const rows=await client.query(`SELECT cluster,program_id,idl_hash,protocol_revision,event_key,signature,slot::text,block_time,
    market,archive_sha256,owner,base_amount::text,quote_amount::text,base_mint,quote_mint,asset_decimals,legacy_idl_hash,legacy_protocol_revision
    FROM dusk_ingestion.retirement_payouts WHERE ${filters.join(' AND ')} ORDER BY block_time,event_key LIMIT 1001`,values);
  if(rows.rows.length>1000)throw new Error('Retirement withdrawal history exceeds its bounded capacity');
  return rows.rows.map(row=>({kind:'market-retirement' as const,direction:'withdrawal' as const,owner:row.owner,market:row.market,
    occurredAt:row.block_time.toISOString(),assets:[{mint:row.base_mint,decimals:row.asset_decimals,amount:row.base_amount},
      {mint:row.quote_mint,decimals:row.asset_decimals,amount:row.quote_amount}],
    provenance:{cluster:row.cluster,programId:row.program_id,idlSha256:row.idl_hash,protocolRevision:row.protocol_revision,
      eventKey:row.event_key,signature:row.signature,slot:row.slot,commitment:'finalized' as const,archiveSha256:row.archive_sha256,
      retiredIdentity:{cluster:row.cluster,programId:row.program_id,idlSha256:row.legacy_idl_hash,protocolRevision:row.legacy_protocol_revision}},
    valuation:{usd:null,basis:'exact-native-withdrawal.v1' as const}}));
}
