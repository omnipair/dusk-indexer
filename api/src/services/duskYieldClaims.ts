import { PublicKey } from '@solana/web3.js';
import { PoolClient } from 'pg';
import pool from '../config/database';
import { loadPinnedProtocol } from '../config/duskProtocol';

const U64_MAX = (1n << 64n) - 1n;
const identity = () => {
  const pin = loadPinnedProtocol();
  return [pin.cluster, pin.dusk.programId, pin.dusk.idlCanonicalSha256, pin.revision];
};

function publicKey(value: unknown): string {
  if (typeof value !== 'string' || new PublicKey(value).toBase58() !== value)
    throw new Error('Invalid yield claim public key');
  return value;
}

function amount(value: unknown): bigint {
  // The pinned Borsh decoder emits decimal strings, never JSON numbers.
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value))
    throw new Error('Invalid yield claim amount');
  const result = BigInt(value);
  if (result > U64_MAX) throw new Error('Yield claim amount exceeds u64');
  return result;
}

/** Paid cash flow. Neither current holdings nor current prices enter this map. */
export function parseYieldClaim(value: unknown, sourceSlot: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Missing yield claim payload');
  const fields = value as Record<string, unknown>;
  const owner = publicKey(fields.owner), market = publicKey(fields.market);
  const lpMint = publicKey(fields.lp_mint), assetMint = publicKey(fields.asset_mint), recipient = publicKey(fields.recipient);
  if (fields.token_kind !== '0' && fields.token_kind !== '1') throw new Error('Unsupported yield claim token kind');
  const swapFeeAmount = amount(fields.swap_fee_amount), interestAmount = amount(fields.interest_amount);
  const recipientCredit = amount(fields.recipient_credit), grossAmount = swapFeeAmount + interestAmount;
  if (grossAmount === 0n || grossAmount > U64_MAX || recipientCredit > grossAmount)
    throw new Error('Yield claim gross/net amounts are inconsistent');
  const metadata = fields.metadata as Record<string, unknown> | undefined;
  if (!metadata || publicKey(metadata.market) !== market || amount(metadata.slot) !== amount(sourceSlot))
    throw new Error('Yield claim metadata differs from its containing event');
  const caller = publicKey(metadata.signer);
  return { owner, market, lpMint, assetMint, recipient, caller,
    tokenKind: fields.token_kind === '0' ? 'ylp' as const : 'hlp' as const,
    swapFeeAmount: swapFeeAmount.toString(), interestAmount: interestAmount.toString(),
    grossAmount: grossAmount.toString(), recipientCredit: recipientCredit.toString() };
}

interface ClaimSource {
  event_key: string; observation_id: string; signature: string; slot: string;
  blockhash: string; block_time: Date | null; payload: unknown; stream_count: string; matching_stream_count: string;
}

/** Caller owns a transaction. The same path handles newly ingested and replayed events. */
export async function projectYieldClaimBatch(client: PoolClient, limit = 500): Promise<number> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error('Invalid yield claim batch limit');
  const active = identity();
  // Serializes replicas without a slot cursor: a later backfill at an older slot
  // remains discoverable. The lock is released by commit/rollback or disconnect.
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`dusk:yield-claims:${JSON.stringify(active)}`]);
  const sources = await client.query<ClaimSource>(`SELECT c.event_key,o.observation_id::text,
    o.transaction_signature AS signature,o.slot::text,o.blockhash,o.decoded_payload AS payload,
    history.block_time,history.stream_count,history.matching_stream_count
    FROM dusk_ingestion.canonical_events c
    JOIN dusk_ingestion.event_observations o USING(cluster,program_id,idl_hash,protocol_revision,event_key,observation_id)
    LEFT JOIN LATERAL (SELECT min(s.time) AS block_time,count(*)::text AS stream_count,
      count(*) FILTER (WHERE s.event_name=o.event_name AND s.transaction_signature=o.transaction_signature
        AND s.slot=o.slot AND s.payload=o.decoded_payload)::text AS matching_stream_count
      FROM dusk_ingestion.event_stream s WHERE
      (s.cluster,s.program_id,s.idl_hash,s.protocol_revision,s.event_key)=
      (c.cluster,c.program_id,c.idl_hash,c.protocol_revision,c.event_key)) history ON true
    WHERE c.cluster=$1 AND c.program_id=$2 AND c.idl_hash=$3 AND c.protocol_revision=$4
      AND c.commitment='finalized' AND o.commitment='finalized' AND o.event_name='YieldClaimed'
      AND NOT EXISTS (SELECT 1 FROM dusk_ingestion.yield_claims y WHERE
        (y.cluster,y.program_id,y.idl_hash,y.protocol_revision,y.event_key)=
        (c.cluster,c.program_id,c.idl_hash,c.protocol_revision,c.event_key))
    ORDER BY o.slot,c.event_key LIMIT $5`, [...active, limit]);
  for (const row of sources.rows) {
    if (row.stream_count !== '1' || row.matching_stream_count !== '1' || !(row.block_time instanceof Date) || !Number.isFinite(row.block_time.getTime()))
      throw new Error(`FINALIZED_INVARIANT: yield claim ${row.event_key} lacks one matching event-time record`);
    const claim = parseYieldClaim(row.payload, row.slot);
    await client.query(`INSERT INTO dusk_ingestion.yield_claims
      (cluster,program_id,idl_hash,protocol_revision,event_key,observation_id,signature,slot,blockhash,block_time,
       owner,market,lp_mint,asset_mint,recipient,token_kind,swap_fee_amount,interest_amount,recipient_credit,payload)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
      [...active,row.event_key,row.observation_id,row.signature,row.slot,row.blockhash,row.block_time,
        claim.owner,claim.market,claim.lpMint,claim.assetMint,claim.recipient,claim.tokenKind === 'ylp' ? 0 : 1,
        claim.swapFeeAmount,claim.interestAmount,claim.recipientCredit,JSON.stringify(row.payload)]);
  }
  return sources.rows.length;
}

export async function projectFinalizedYieldClaims(limit = 500): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const count = await projectYieldClaimBatch(client, limit);
    await client.query('COMMIT');
    return count;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

export interface YieldClaimQuery { owner: string; market?: string; since?: string; until?: string; limit: number; offset: number }

/** Caller owns a repeatable-read transaction for consistent totals and pages. */
export async function readYieldClaims(client: PoolClient, options: YieldClaimQuery) {
  const active = identity();
  const values: unknown[] = [...active, publicKey(options.owner)];
  const filters = ['cluster=$1','program_id=$2','idl_hash=$3','protocol_revision=$4','owner=$5'];
  if (options.market) { values.push(publicKey(options.market)); filters.push(`market=$${values.length}`); }
  if (options.since) { values.push(options.since); filters.push(`block_time>=$${values.length}::timestamptz`); }
  if (options.until) { values.push(options.until); filters.push(`block_time<=$${values.length}::timestamptz`); }
  const where = filters.join(' AND ');
  const totals = await client.query<{ total: string }>(`SELECT count(*)::text AS total FROM dusk_ingestion.yield_claims WHERE ${where}`, values);
  const rows = await client.query(`SELECT event_key,observation_id::text,signature,slot::text,blockhash,block_time,payload,projected_at
    FROM dusk_ingestion.yield_claims WHERE ${where} ORDER BY slot DESC,event_key DESC
    LIMIT $${values.length+1} OFFSET $${values.length+2}`, [...values,options.limit,options.offset]);
  // This measures projection lag, not missing RPC ranges. A zero backlog cannot
  // establish that ingestion captured every historical transaction.
  const coverage = await client.query(`SELECT count(*)::text AS indexed_claims,count(y.event_key)::text AS projected_claims,
    min(o.slot)::text AS first_indexed_slot,max(o.slot)::text AS last_indexed_slot,max(y.projected_at) AS last_projected_at
    FROM dusk_ingestion.canonical_events c
    JOIN dusk_ingestion.event_observations o USING(cluster,program_id,idl_hash,protocol_revision,event_key,observation_id)
    LEFT JOIN dusk_ingestion.yield_claims y USING(cluster,program_id,idl_hash,protocol_revision,event_key,observation_id)
    WHERE c.cluster=$1 AND c.program_id=$2 AND c.idl_hash=$3 AND c.protocol_revision=$4
      AND c.commitment='finalized' AND o.commitment='finalized' AND o.event_name='YieldClaimed'`, active);
  const summary = coverage.rows[0];
  const provenance = { cluster: active[0], programId: active[1], idlSha256: active[2], protocolRevision: active[3], commitment: 'finalized' as const };
  return {
    claims: rows.rows.map((row) => ({ ...parseYieldClaim(row.payload, row.slot), eventKey: row.event_key,
      signature: row.signature, blockTime: (row.block_time as Date).toISOString(),
      provenance: { ...provenance, sourceSlot: row.slot, blockhash: row.blockhash, observationId: row.observation_id,
        projectedAt: (row.projected_at as Date).toISOString() } })),
    pagination: { limit: options.limit, offset: options.offset, total: Number(totals.rows[0].total) },
    coverage: { ...provenance, basis: 'claimed-cash-flow' as const, scope: 'protocol-identity' as const,
      indexedClaims: summary.indexed_claims as string, projectedClaims: summary.projected_claims as string,
      pendingClaims: (BigInt(summary.indexed_claims)-BigInt(summary.projected_claims)).toString(),
      projectionComplete: summary.indexed_claims === summary.projected_claims,
      ingestionRangeComplete: false as const, accrualHistoryAvailable: false as const,
      firstIndexedSlot: summary.first_indexed_slot as string | null, lastIndexedSlot: summary.last_indexed_slot as string | null,
      lastProjectedAt: (summary.last_projected_at as Date | null)?.toISOString() ?? null },
  };
}

export async function listYieldClaims(options: YieldClaimQuery) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const result = await readYieldClaims(client, options);
    await client.query('COMMIT');
    return result;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
