import { PoolClient } from 'pg';

/** A rejected finalized observation must also stop consumers of prior projections. */
export async function assertNativeEvidenceConsistent(client: PoolClient,identity: string[]): Promise<void> {
  const conflicts = await client.query(`SELECT 1 FROM dusk_ingestion.account_scans
      WHERE cluster=$1 AND program_id=$2 AND idl_hash=$3 AND protocol_revision=$4
      GROUP BY slot HAVING count(DISTINCT (blockhash,parent_slot,content_hash))>1
    UNION ALL SELECT 1 FROM dusk_ingestion.lp_token_scans
      WHERE cluster=$1 AND program_id=$2 AND idl_hash=$3 AND protocol_revision=$4
      GROUP BY lp_mint,slot HAVING count(DISTINCT (blockhash,parent_slot,content_hash))>1 LIMIT 1`,identity);
  if (conflicts.rowCount) throw Object.assign(new Error('FINALIZED_INVARIANT: contradictory native discovery evidence'),{ status: 503 });
}
