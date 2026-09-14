import pool from '../config/database';
import { loadPinnedProtocol } from '../config/duskProtocol';
import { assertNativeEvidenceConsistent } from './duskNativeEvidence';

export type NativeAccountKind = 'markets' | 'borrow' | 'leverage' | 'yield' | 'orders';
const accountNames: Record<NativeAccountKind, string[]> = {
  markets: ['Market'], borrow: ['BorrowPosition'], leverage: ['LeveragePosition'],
  yield: ['YieldAccount'], orders: ['LeverageOrder', 'LeverageEntryOrder', 'HlpOrder'],
};

/** Identity-scoped discovery. These records never authorize a write. */
export async function listNativeAccounts(options: {
  cluster: string; kind: NativeAccountKind; owner?: string; market?: string; limit: number; offset: number;
}) {
  const pin = loadPinnedProtocol();
  if (options.cluster !== pin.cluster) throw new Error('Native query cluster differs from the protocol lock');
  const program = options.kind === 'orders' ? pin.leverageDelegate : pin.dusk;
  const values: unknown[] = [options.cluster, program.programId, program.idlCanonicalSha256, pin.revision, accountNames[options.kind]];
  const filters = ['cluster=$1', 'program_id=$2', 'idl_hash=$3', 'protocol_revision=$4', 'account_name=ANY($5::text[])', 'NOT closed'];
  if (options.owner) { values.push(options.owner); filters.push(`decoded_fields->>'owner'=$${values.length}`); }
  if (options.market) { values.push(options.market); filters.push(`COALESCE(decoded_fields->>'market',account_pubkey)=$${values.length}`); }
  const where = filters.join(' AND ');
  const connection = await pool.connect();
  try {
    await connection.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await assertNativeEvidenceConsistent(connection,values.slice(0,4) as string[]);
    const scan = await connection.query<{ slot: string; observed_at: Date; blockhash: string }>(
      'SELECT slot::text,observed_at,blockhash FROM dusk_ingestion.account_scans WHERE cluster=$1 AND program_id=$2 AND idl_hash=$3 AND protocol_revision=$4 AND applied_at IS NOT NULL ORDER BY slot DESC LIMIT 1', values.slice(0,4),
    );
    if (!scan.rows[0]) throw Object.assign(new Error('Native account scan has not completed for this protocol identity'), { status: 503 });
    const total = await connection.query<{ total: string }>(`SELECT count(*)::text AS total FROM dusk_ingestion.native_accounts WHERE ${where}`, values);
    const rows = await connection.query(`SELECT account_pubkey,account_name,decoded_fields,projections,source_slot::text,blockhash,observed_at FROM dusk_ingestion.native_accounts WHERE ${where} ORDER BY account_pubkey LIMIT $${values.length+1} OFFSET $${values.length+2}`, [...values,options.limit,options.offset]);
    await connection.query('COMMIT');
    const identity = { cluster: pin.cluster, programId: program.programId, idlSha256: program.idlCanonicalSha256, protocolRevision: pin.revision };
    return {
      accounts: rows.rows.map((row) => ({ address: row.account_pubkey, type: row.account_name, fields: row.decoded_fields, projection: row.projections,
        provenance: { ...identity, commitment: 'finalized' as const, sourceSlot: row.source_slot, blockhash: row.blockhash, observedAt: (row.observed_at as Date).toISOString() },
      })),
      pagination: { limit: options.limit, offset: options.offset, total: Number(total.rows[0].total) },
      coverage: { ...identity, commitment: 'finalized' as const, complete: true, sourceSlot: scan.rows[0].slot, blockhash: scan.rows[0].blockhash, observedAt: scan.rows[0].observed_at.toISOString() },
    };
  } catch (error) {
    await connection.query('ROLLBACK');
    throw error;
  } finally { connection.release(); }
}
