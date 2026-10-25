/**
 * One owner's governance position: the yLP it has locked behind each
 * proposal, and, for one market, whether its yLP yield accounts exist.
 *
 * Locked yLP comes from streamed events. A proposer's own sponsorship is
 * locked at creation (`ParameterProposalCreated.initial_support`) without a
 * support event; `ParameterProposalSupported` reports the supporter's locked
 * total after it, and `ParameterProposalSupportWithdrawn` the amount
 * returned. Yield-account existence is not an event, so it is an account
 * read at or after the stream's slot.
 */

import { PublicKey } from '@solana/web3.js';
import type { Pool, PoolClient } from 'pg';
import type { Dusk } from '@omnipair/dusk-sdk';

import pool from '../config/database';
import { loadPinnedProtocol } from '../config/duskProtocol';
import type { DuskDeploymentEnvelope } from './duskDeploymentService';
import { captureWithDeadline, currentDisplayState, displayRuntime } from './duskDisplayState';
import { readStreamCursor } from './duskHistoryCoverage';
import { boundedDuskRpcRead, deriveYieldAccountAddress } from './virtualBook/native';

export interface GovernanceSupport {
  proposal: string;
  market: string;
  lockedAmount: string;
}

export interface GovernanceYieldAccount {
  assetMint: string;
  address: string;
  initialized: boolean;
  /** Created at an older, shorter layout; a support must grow it first. */
  needsGrowth: boolean;
}

const U64_MAX = (1n << 64n) - 1n;

function amount(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,19})$/.test(value) || BigInt(value) > U64_MAX)
    throw new Error('Invalid governance support amount');
  return BigInt(value);
}

/** The owner's locked yLP per proposal, folded in stream order. The stream's
 * slot is read after the events and covers them. */
export async function readOwnerGovernanceSupports(
  owner: string,
  market: string | null,
  client: Pool | PoolClient = pool,
): Promise<{ supports: GovernanceSupport[]; sourceSlot: number }> {
  const pin = loadPinnedProtocol();
  const result = await client.query<{ event_name: string; payload: Record<string, unknown>; market: string; delegated_creation: boolean }>(
    `SELECT e.event_name,e.payload,c.payload->>'market' AS market,
      EXISTS (SELECT 1 FROM dusk_ingestion.streamed_events g
        JOIN dusk_ingestion.event_observations support_observation
          ON (support_observation.cluster,support_observation.program_id,support_observation.idl_hash,
              support_observation.protocol_revision,support_observation.observation_id)
            =(g.cluster,g.program_id,g.idl_hash,g.protocol_revision,g.observation_id)
        WHERE (g.cluster,g.program_id,g.idl_hash,g.protocol_revision)=(c.cluster,c.program_id,c.idl_hash,c.protocol_revision)
          AND g.signature=c.signature AND g.event_name='GovernanceSupportChanged'
          AND support_observation.instruction_path[1]=creation_observation.instruction_path[1]
          AND g.payload->>'proposal'=c.payload->>'proposal') AS delegated_creation
    FROM dusk_ingestion.streamed_events e
    JOIN dusk_ingestion.streamed_events c
      ON (c.cluster,c.program_id,c.idl_hash,c.protocol_revision)=(e.cluster,e.program_id,e.idl_hash,e.protocol_revision)
      AND c.event_name='ParameterProposalCreated' AND c.payload->>'proposal'=e.payload->>'proposal'
    JOIN dusk_ingestion.event_observations creation_observation
      ON (creation_observation.cluster,creation_observation.program_id,creation_observation.idl_hash,
          creation_observation.protocol_revision,creation_observation.observation_id)
        =(c.cluster,c.program_id,c.idl_hash,c.protocol_revision,c.observation_id)
    WHERE e.cluster=$1 AND e.program_id=$2 AND e.idl_hash=$3 AND e.protocol_revision=$4
      AND ((e.event_name='ParameterProposalCreated' AND e.payload->>'proposer'=$5)
        OR (e.event_name IN ('ParameterProposalSupported','ParameterProposalSupportWithdrawn') AND e.payload->>'supporter'=$5)
        OR (e.event_name='GovernanceSupportChanged' AND e.payload->>'owner'=$5))
      AND ($6::text IS NULL OR c.payload->>'market'=$6)
    ORDER BY e.slot,e.observation_id`,
    [pin.cluster, pin.dusk.programId, pin.dusk.idlCanonicalSha256, pin.revision, owner, market],
  );
  const locked = new Map<string, { market: string; direct: bigint; reusable: bigint }>();
  for (const row of result.rows) {
    const proposal = String(row.payload.proposal),
      current = locked.get(proposal) ?? { market: row.market, direct: 0n, reusable: 0n };
    if (row.event_name === 'ParameterProposalCreated')
      // Delegated creation reports the proposal's aggregate reusable support;
      // owner events from that same outer instruction give individual balances.
      current.direct = row.delegated_creation ? 0n : amount(row.payload.initial_support);
    else if (row.event_name === 'ParameterProposalSupported')
      current.direct = amount(row.payload.supporter_locked);
    else if (row.event_name === 'GovernanceSupportChanged')
      current.reusable = amount(row.payload.owner_support);
    else current.direct -= amount(row.payload.amount);
    if (current.direct < 0n) throw new Error('Governance support withdrawn beyond its lock');
    locked.set(proposal, current);
  }
  const stream = await readStreamCursor(client);
  if (!stream) throw Object.assign(new Error('The Dusk stream has not started'), { status: 503 });
  return {
    supports: [...locked.entries()]
      .filter(([, value]) => value.direct + value.reusable > 0n)
      .map(([proposal, value]) => ({ proposal, market: value.market,
        lockedAmount: (value.direct + value.reusable).toString() }))
      .sort((a, b) => a.market.localeCompare(b.market) || a.proposal.localeCompare(b.proposal)),
    sourceSlot: Number(stream.throughSlot),
  };
}

/** A market's mints from its streamed creation. */
export async function readStreamedMarketMints(
  market: string,
  client: Pool | PoolClient = pool,
): Promise<{ ylpMint: string; baseMint: string; quoteMint: string } | null> {
  const pin = loadPinnedProtocol();
  const result = await client.query<{ ylp_mint: string; base_mint: string; quote_mint: string }>(
    `SELECT ylp_mint,base_mint,quote_mint FROM dusk_ingestion.streamed_markets
    WHERE cluster=$1 AND program_id=$2 AND idl_hash=$3 AND protocol_revision=$4 AND market=$5`,
    [pin.cluster, pin.dusk.programId, pin.dusk.idlCanonicalSha256, pin.revision, market],
  );
  const row = result.rows[0];
  return row ? { ylpMint: row.ylp_mint, baseMint: row.base_mint, quoteMint: row.quote_mint } : null;
}

export const ownerGovernanceDependencies = {
  supports: readOwnerGovernanceSupports,
  marketMints: readStreamedMarketMints,
};

export async function captureOwnerGovernance(
  dusk: Dusk,
  selection: { owner: string; market: string | null },
  deployment: DuskDeploymentEnvelope,
  signal?: AbortSignal,
  deps = ownerGovernanceDependencies,
) {
  const observedAt = Date.now();
  const { supports, sourceSlot } = await deps.supports(selection.owner, selection.market);
  let yieldAccounts: GovernanceYieldAccount[] | null = null,
    accountSlot = 0;
  if (selection.market) {
    const mints = await deps.marketMints(selection.market);
    if (!mints) throw Object.assign(new Error('Unknown governance market'), { status: 404 });
    const addresses = [mints.baseMint, mints.quoteMint].map(
      (asset) =>
        deriveYieldAccountAddress(
          new PublicKey(selection.market!),
          new PublicKey(selection.owner),
          new PublicKey(mints.ylpMint),
          new PublicKey(asset),
          'ylp',
          dusk.program.programId,
        )[0],
    );
    const floor = Math.max(deployment.sourceSlot, sourceSlot);
    const read = await boundedDuskRpcRead(
      () => dusk.program.provider.connection.getMultipleAccountsInfoAndContext(addresses, { commitment: 'confirmed', minContextSlot: floor }),
      signal,
    );
    if (!Number.isSafeInteger(read.context.slot) || read.context.slot < floor || read.value.length !== addresses.length)
      throw new Error('Governance yield accounts are behind the stream');
    accountSlot = read.context.slot;
    const size = dusk.program.coder.accounts.size('yieldAccount');
    yieldAccounts = read.value.map((info, index) => {
      if (info && (info.executable || !info.owner.equals(dusk.program.programId)))
        throw new Error('Invalid governance yield account owner');
      return {
        assetMint: index === 0 ? mints.baseMint : mints.quoteMint,
        address: addresses[index].toBase58(),
        initialized: info !== null,
        needsGrowth: info !== null && info.data.length < size,
      };
    });
  }
  signal?.throwIfAborted();
  if (Date.now() >= observedAt + 15_000) throw new Error('Governance capture expired');
  return {
    schemaVersion: 'dusk-owner-governance.v1' as const,
    owner: selection.owner,
    market: selection.market,
    observedAt,
    expiresAt: observedAt + 15_000,
    sourceSlot: Math.max(sourceSlot, accountSlot),
    supports,
    yieldAccounts,
  };
}

export function currentOwnerGovernance(selection: { owner: string; market: string | null }) {
  return currentDisplayState(`governance:${selection.owner}:${selection.market ?? '*'}`, async (deployment) => {
    const { dusk } = await displayRuntime();
    return captureWithDeadline((signal) => captureOwnerGovernance(dusk, selection, deployment, signal));
  });
}
