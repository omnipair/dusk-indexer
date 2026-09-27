import { PublicKey } from '@solana/web3.js';
import { PoolClient } from 'pg';
import pool from '../config/database';
import { loadPinnedProtocol } from '../config/duskProtocol';
import { readStreamCursor } from './duskHistoryCoverage';

/** `market` is one canonical base58 key, or absent for every market. */
export function governanceSelection(value: unknown): string | null {
  if (value === undefined) return null;
  const invalid = () => Object.assign(new Error('Invalid governance market'),{ status: 400 });
  if (typeof value !== 'string' || !value) throw invalid();
  try { if (new PublicKey(value).toBase58() === value) return value; } catch { /* rejected below */ }
  throw invalid();
}

type Fields = Record<string,unknown>;
const fields = (value: unknown): Fields => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid governance event payload');
  return value as Fields;
};
const integer = (value: unknown,label: string): string => {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,19})$/.test(value)) throw new Error(`Invalid governance ${label}`);
  return value;
};
const small = (value: unknown,label: string): number => {
  const parsed = Number(integer(value,label));
  if (!Number.isSafeInteger(parsed)) throw new Error(`Invalid governance ${label}`);
  return parsed;
};
/** The decoder renders a `[u8; N]` array as one `0x`-prefixed hex string. */
function hex32(value: unknown,label: string): string {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error(`Invalid governance ${label}`);
  return value.slice(2).toLowerCase();
}
const nullableInteger = (value: string | null) => value === null ? null : Number(value);

interface ProposalRow {
  proposal: string; market: string; created: unknown; total_locked: string; status: number;
  eligible_supply_at_queue: string | null; queued_support: string | null; queued_at: string | null; execute_after: string | null;
  execution_deadline: string | null; executed_at: string | null; created_slot: string; last_slot: string;
}

/** Proposals and each market's eligible yLP, from streamed events. The
 * stream's slot is read last, so it covers every event included. */
export async function readGovernanceProposals(client: PoolClient,market: string | null) {
  const pin = loadPinnedProtocol(),identity = [pin.cluster,pin.dusk.programId,pin.dusk.idlCanonicalSha256,pin.revision];
  const proposals = await client.query<ProposalRow>(`SELECT proposal,market,created,total_locked,status,eligible_supply_at_queue,queued_support,
      queued_at::text,execute_after::text,execution_deadline::text,executed_at::text,created_slot::text,last_slot::text
    FROM dusk_ingestion.streamed_governance_proposals
    WHERE cluster=$1 AND program_id=$2 AND idl_hash=$3 AND protocol_revision=$4 AND ($5::text IS NULL OR market=$5)
    ORDER BY market,proposal`,[...identity,market]);
  if (proposals.rows.length>5000) throw new Error('Governance proposals exceed the bounded response');
  const addresses = [...new Set([...proposals.rows.map((row) => row.market),...(market ? [market] : [])])].sort();
  const observations = await client.query<{ market: string; slot: string; time: Date; payload: unknown }>(`SELECT market,slot::text,time,payload
    FROM dusk_ingestion.streamed_latest_market_observations
    WHERE cluster=$1 AND program_id=$2 AND idl_hash=$3 AND protocol_revision=$4 AND market=ANY($5::text[])`,[...identity,addresses]);
  const stream = await readStreamCursor(client);
  if (!stream) throw Object.assign(new Error('The Dusk stream has not started'),{ status: 503 });
  const observed = new Map(observations.rows.map((row) => [row.market,row]));
  return {
    schemaVersion: 'dusk-governance-proposals.v2' as const,
    market,
    sourceSlot: Number(stream.throughSlot),
    markets: addresses.map((address) => {
      const row = observed.get(address);
      if (!row) return { address,eligibleYlp: null,governanceLockedYlp: null,observedSlot: null,observedAt: null };
      const payload = fields(row.payload);
      return { address,eligibleYlp: integer(payload.eligible_ylp,'eligible yLP'),
        governanceLockedYlp: integer(payload.governance_locked_ylp,'locked yLP'),
        observedSlot: Number(row.slot),observedAt: row.time.toISOString() };
    }),
    proposals: proposals.rows.map((row) => {
      const created = fields(row.created),metadata = fields(created.metadata);
      if (!Number.isInteger(row.status) || row.status<0 || row.status>5) throw new Error('Invalid governance status');
      return {
        address: row.proposal,market: row.market,proposer: String(created.proposer),
        nonce: integer(created.nonce,'nonce'),family: small(created.family,'family'),
        familyRevision: integer(created.family_revision,'family revision'),
        digest: hex32(created.digest,'digest'),
        update: created.update,
        metadata: { version: small(metadata.version,'metadata version'),title: String(metadata.title),
          descriptionUri: String(metadata.description_uri),descriptionSha256: hex32(metadata.description_sha256,'description hash'),
          descriptionLen: small(metadata.description_len,'description length') },
        sponsorshipFloor: integer(created.sponsorship_floor,'sponsorship floor'),
        initialSupport: integer(created.initial_support,'initial support'),
        totalLocked: integer(row.total_locked,'total locked'),
        status: row.status,
        eligibleSupplyAtQueue: row.eligible_supply_at_queue,queuedSupport: row.queued_support,
        queuedAt: nullableInteger(row.queued_at),executeAfter: nullableInteger(row.execute_after),
        executionDeadline: nullableInteger(row.execution_deadline),executedAt: nullableInteger(row.executed_at),
        createdSlot: Number(row.created_slot),lastSlot: Number(row.last_slot),
      };
    }),
  };
}

export async function listGovernanceProposals(market: string | null) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const result = await readGovernanceProposals(client,market);
    await client.query('COMMIT');
    return result;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
