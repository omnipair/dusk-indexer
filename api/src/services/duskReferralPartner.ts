/**
 * One authority's referral partner and its claimable interest per market and
 * debt asset.
 *
 * The partner's configuration and every accrual amount come from streamed
 * events: `ReferralPartnerConfigured` and `ReferralRecipientUpdated` set the
 * terms, `ReferralInterestAccrued` adds to an accrual and
 * `ReferralInterestClaimed` reports what remains after a claim. Whether an
 * accrual account exists, the asset mints' token programs and transfer-fee
 * schedules, and the epoch those fees apply at are not events: one account
 * read at or after the stream's slot supplies them, so each stream's
 * recipient credit is the amount net of the transfer fee in force now.
 */

import {
  calculateEpochFee,
  getTransferFeeConfig,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  unpackMint,
} from '@solana/spl-token';
import { PublicKey, SYSVAR_CLOCK_PUBKEY } from '@solana/web3.js';
import type { Pool, PoolClient } from 'pg';
import type { Dusk } from '@omnipair/dusk-sdk';

import pool from '../config/database';
import { loadPinnedProtocol } from '../config/duskProtocol';
import type { DuskDeploymentEnvelope } from './duskDeploymentService';
import { captureWithDeadline, currentDisplayState, displayRuntime } from './duskDisplayState';
import { readStreamCursor } from './duskHistoryCoverage';
import { boundedDuskRpcRead } from './virtualBook/native';

const U64_MAX = (1n << 64n) - 1n;
const CLOCK_OWNER = 'Sysvar1111111111111111111111111111111111111';
/** One request reads every asset mint with the Clock. */
const MAX_REFERRAL_MINTS = 99;

const programAddress = (seeds: Buffer[]) =>
  PublicKey.findProgramAddressSync(seeds, new PublicKey(loadPinnedProtocol().dusk.programId))[0];
export const referralPartnerAddress = (authority: string) =>
  programAddress([Buffer.from('referral_partner'), new PublicKey(authority).toBuffer()]);
const referralAccrualAddress = (partner: PublicKey, market: string, assetMint: string) =>
  programAddress([Buffer.from('referral_accrual'), partner.toBuffer(), new PublicKey(market).toBuffer(), new PublicKey(assetMint).toBuffer()]);
const interestVaultAddress = (market: string, assetMint: string) =>
  programAddress([Buffer.from('market_interest'), new PublicKey(market).toBuffer(), new PublicKey(assetMint).toBuffer()]);

export interface ReferralPartnerTerms {
  authority: string;
  recipient: string;
  interestShareBps: number;
  active: boolean;
}

export interface ReferralStream {
  address: string;
  market: string;
  assetMint: string;
  assetDecimals: number;
  tokenProgram: string;
  interestVault: string;
  initialized: boolean;
  amount: string;
  /** The amount net of the asset's current transfer fee. */
  recipientCredit: string;
}

function unsigned(value: unknown, label: string): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,19})$/.test(value) || BigInt(value) > U64_MAX)
    throw new Error(`Invalid referral ${label}`);
  return BigInt(value);
}

/** The partner's terms, every market and each accrual amount from streamed
 * events. The stream's slot is read last and covers them. */
export async function readStreamedReferralState(
  authority: string,
  client: Pool | PoolClient = pool,
): Promise<{
  partner: ReferralPartnerTerms | null;
  markets: { market: string; baseMint: string; quoteMint: string }[];
  accruals: Map<string, bigint>;
  sourceSlot: number;
}> {
  const pin = loadPinnedProtocol(),
    identity = [pin.cluster, pin.dusk.programId, pin.dusk.idlCanonicalSha256, pin.revision];
  const partnerAddress = referralPartnerAddress(authority).toBase58();
  const terms = await client.query<{ event_name: string; payload: Record<string, unknown> }>(
    `SELECT event_name,payload FROM dusk_ingestion.streamed_events
    WHERE cluster=$1 AND program_id=$2 AND idl_hash=$3 AND protocol_revision=$4
      AND event_name IN ('ReferralPartnerConfigured','ReferralRecipientUpdated') AND payload->>'referral_partner'=$5
    ORDER BY slot,observation_id`,
    [...identity, partnerAddress],
  );
  let partner = null as ReferralPartnerTerms | null;
  for (const row of terms.rows) {
    if (row.payload.authority !== authority) throw new Error('Referral partner authority changed');
    if (row.event_name === 'ReferralPartnerConfigured') {
      const share = Number(row.payload.interest_share_bps);
      if (!Number.isSafeInteger(share) || share < 0 || share > 10_000 || typeof row.payload.active !== 'boolean')
        throw new Error('Invalid referral partner terms');
      partner = { authority, recipient: String(row.payload.recipient), interestShareBps: share, active: row.payload.active };
    } else if (partner) partner = { ...partner, recipient: String(row.payload.recipient) };
  }
  const markets = await client.query<{ market: string; base_mint: string; quote_mint: string }>(
    `SELECT market,base_mint,quote_mint FROM dusk_ingestion.streamed_markets
    WHERE cluster=$1 AND program_id=$2 AND idl_hash=$3 AND protocol_revision=$4 ORDER BY market`,
    identity,
  );
  const movements = await client.query<{ event_name: string; payload: Record<string, unknown> }>(
    `SELECT event_name,payload FROM dusk_ingestion.streamed_events
    WHERE cluster=$1 AND program_id=$2 AND idl_hash=$3 AND protocol_revision=$4
      AND event_name IN ('ReferralInterestAccrued','ReferralInterestClaimed') AND payload->>'referral_partner'=$5
    ORDER BY slot,observation_id`,
    [...identity, partnerAddress],
  );
  const accruals = new Map<string, bigint>();
  for (const row of movements.rows) {
    const address = String(row.payload.referral_accrual);
    const next =
      row.event_name === 'ReferralInterestAccrued'
        ? (accruals.get(address) ?? 0n) + unsigned(row.payload.accrued_amount, 'accrual')
        : unsigned(row.payload.remaining_accrual, 'remaining accrual');
    if (next > U64_MAX) throw new Error('Referral accrual overflow');
    accruals.set(address, next);
  }
  const stream = await readStreamCursor(client);
  if (!stream) throw Object.assign(new Error('The Dusk stream has not started'), { status: 503 });
  return {
    partner,
    markets: markets.rows.map((row) => ({ market: row.market, baseMint: row.base_mint, quoteMint: row.quote_mint })),
    accruals,
    sourceSlot: Number(stream.throughSlot),
  };
}

export const referralPartnerDependencies = { state: readStreamedReferralState };

export async function captureReferralPartner(
  dusk: Dusk,
  authority: string,
  deployment: DuskDeploymentEnvelope,
  signal?: AbortSignal,
  deps = referralPartnerDependencies,
) {
  const observedAt = Date.now();
  const programId = dusk.program.programId;
  if (programId.toBase58() !== loadPinnedProtocol().dusk.programId) throw new Error('Referral SDK deployment mismatch');
  const partnerAddress = referralPartnerAddress(authority);
  const state = await deps.state(authority);
  const connection = dusk.program.provider.connection;
  let streams: ReferralStream[] = [],
    slot = 0;
  if (state.partner && state.markets.length) {
    const rows = state.markets.flatMap(({ market, baseMint, quoteMint }) =>
      [baseMint, quoteMint].map((assetMint) => ({ market, assetMint, address: referralAccrualAddress(partnerAddress, market, assetMint) })),
    );
    const mints = [...new Set(rows.map((row) => row.assetMint))].map((mint) => new PublicKey(mint));
    if (mints.length > MAX_REFERRAL_MINTS) throw new Error('Referral mints exceed the bounded capture');
    // Fees apply at the Clock's epoch, read in the same bank as the mints.
    const mintRead = await boundedDuskRpcRead(
      () => connection.getMultipleAccountsInfoAndContext([...mints, SYSVAR_CLOCK_PUBKEY], {
        commitment: 'confirmed',
        minContextSlot: Math.max(deployment.sourceSlot, state.sourceSlot),
      }),
      signal,
    );
    slot = mintRead.context.slot;
    if (!Number.isSafeInteger(slot) || slot < Math.max(deployment.sourceSlot, state.sourceSlot) || mintRead.value.length !== mints.length + 1)
      throw new Error('Referral mints are behind the stream');
    const clock = mintRead.value[mints.length];
    if (!clock || clock.owner.toBase58() !== CLOCK_OWNER || clock.data.length !== 40 || clock.data.readBigUInt64LE(0) !== BigInt(slot))
      throw new Error('Referral bank identity changed');
    const epoch = clock.data.readBigUInt64LE(16);
    const decodedMints = new Map(
      mints.map((mint, index) => {
        const info = mintRead.value[index];
        if (!info || info.executable || (!info.owner.equals(TOKEN_PROGRAM_ID) && !info.owner.equals(TOKEN_2022_PROGRAM_ID)))
          throw new Error('Invalid referral asset mint');
        const decoded = unpackMint(mint, info, info.owner);
        if (!decoded.isInitialized) throw new Error('Referral asset mint is not initialized');
        return [mint.toBase58(), { decoded, program: info.owner.toBase58() }];
      }),
    );
    // Accrual accounts are created by their own instruction without an event.
    const exists = new Map<string, boolean>();
    for (let start = 0; start < rows.length; start += 100) {
      const keys = rows.slice(start, start + 100).map((row) => row.address);
      const read = await boundedDuskRpcRead(
        () => connection.getMultipleAccountsInfoAndContext(keys, { commitment: 'confirmed', minContextSlot: slot }),
        signal,
      );
      if (!Number.isSafeInteger(read.context.slot) || read.context.slot < slot || read.value.length !== keys.length)
        throw new Error('Referral accruals are behind the stream');
      slot = read.context.slot;
      read.value.forEach((info, index) => {
        if (info && (info.executable || !info.owner.equals(programId))) throw new Error('Invalid referral accrual owner');
        exists.set(keys[index].toBase58(), info !== null);
      });
    }
    streams = rows.map((row) => {
      const address = row.address.toBase58(),
        amount = state.accruals.get(address) ?? 0n;
      if (!exists.get(address) && amount !== 0n) throw new Error('Referral accrual is missing its account');
      const mint = decodedMints.get(row.assetMint)!;
      const fee = getTransferFeeConfig(mint.decoded);
      return {
        address,
        market: row.market,
        assetMint: row.assetMint,
        assetDecimals: mint.decoded.decimals,
        tokenProgram: mint.program,
        interestVault: interestVaultAddress(row.market, row.assetMint).toBase58(),
        initialized: exists.get(address) === true,
        amount: amount.toString(),
        recipientCredit: (amount - (fee ? calculateEpochFee(fee, epoch, amount) : 0n)).toString(),
      };
    });
  }
  signal?.throwIfAborted();
  if (Date.now() >= observedAt + 15_000) throw new Error('Referral capture expired');
  return {
    schemaVersion: 'dusk-referral-partner.v1' as const,
    authority,
    address: partnerAddress.toBase58(),
    observedAt,
    expiresAt: observedAt + 15_000,
    sourceSlot: Math.max(state.sourceSlot, slot),
    partner: state.partner,
    streams,
  };
}

export function currentReferralPartner(authority: string) {
  return currentDisplayState(`referral-partner:${authority}`, async (deployment) => {
    const { dusk } = await displayRuntime();
    return captureWithDeadline((signal) => captureReferralPartner(dusk, authority, deployment, signal));
  });
}
