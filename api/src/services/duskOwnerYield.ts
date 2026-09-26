/**
 * An owner's claimable LP yield: every (holder, market, LP mint) it has held,
 * and every hLP stop order escrow it still owns, valued at the amount Harvest
 * would pay now.
 *
 * Discovery comes from the database: the streamed LP balances (including
 * holdings that have since gone to zero, whose yield accounts can still hold
 * unclaimed amounts) and the delegate's hLP order instructions (an escrow
 * holds shares on the owner's behalf until its yield is settled). Claimable
 * amounts change without a transaction as interest and fees accrue, so each
 * group is valued from the program's `preview_market` post-state in one
 * simulated bank with its yield accounts, LP holding, asset mints and Clock.
 */

import {
  calculateEpochFee,
  getAssociatedTokenAddressSync,
  getTransferFeeConfig,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  unpackAccount,
  unpackMint,
} from '@solana/spl-token';
import {
  ComputeBudgetProgram,
  PublicKey,
  SYSVAR_CLOCK_PUBKEY,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import type { AccountInfo } from '@solana/web3.js';
import type { Pool, PoolClient } from 'pg';
import type { Dusk, Market, YieldAccount } from '@omnipair/dusk-sdk';

import pool from '../config/database';
import { loadPinnedProtocol } from '../config/duskProtocol';
import type { DuskDeploymentEnvelope } from './duskDeploymentService';
import { captureWithDeadline, currentDisplayState, displayRuntime } from './duskDisplayState';
import { readStreamCursor } from './duskHistoryCoverage';
import { completeBatch } from './duskWalletSnapshot';
import { projectLiveYield } from './duskYieldAccounting';
import { boundedDuskRpcRead, decodePreviewMarketReturnData, deriveYieldAccountAddress } from './virtualBook/native';

const CLOCK_OWNER = 'Sysvar1111111111111111111111111111111111111';
const MAX_YIELD_GROUPS = 64;

export interface YieldGroup {
  /** The LP holder: the owner, or an hLP order escrow acting for it. */
  holder: string;
  market: string;
  lpMint: string;
  kind: 'ylp' | 'hlp';
  baseMint: string;
  quoteMint: string;
}

export interface YieldStream {
  address: string;
  holder: string;
  market: string;
  lpMint: string;
  assetMint: string;
  kind: 'ylp' | 'hlp';
  recipient: string;
  initialized: boolean;
  needsGrowth: boolean;
  lpBalance: string;
  lpDecimals: number;
  assetDecimals: number;
  swapFeeAmount: string;
  interestAmount: string;
  /** Total net of each asset transfer's current transfer fee. */
  recipientCredit: string;
  sourceSlot: number;
}

/** Holdings and live escrows for one owner. The stream's slot is read last
 * and covers them. */
export async function readOwnerYieldGroups(
  owner: string,
  client: Pool | PoolClient = pool,
): Promise<{ groups: YieldGroup[]; sourceSlot: number }> {
  const pin = loadPinnedProtocol();
  const dusk = [pin.cluster, pin.dusk.programId, pin.dusk.idlCanonicalSha256, pin.revision];
  const delegate = [pin.cluster, pin.leverageDelegate.programId, pin.leverageDelegate.idlCanonicalSha256, pin.revision];
  const holdings = await client.query<{ market: string; lp_mint: string; kind: string; base_mint: string; quote_mint: string }>(
    `SELECT b.market,b.lp_mint,b.kind,m.base_mint,m.quote_mint FROM dusk_ingestion.streamed_lp_balances b
    JOIN dusk_ingestion.streamed_markets m USING(cluster,program_id,idl_hash,protocol_revision,market)
    WHERE b.cluster=$1 AND b.program_id=$2 AND b.idl_hash=$3 AND b.protocol_revision=$4 AND b.owner=$5
    ORDER BY b.market,b.lp_mint`,
    [...dusk, owner],
  );
  // An escrow keeps accruing for its owner until settle_hlp_order_yield
  // closes it, including after the order executes or is cancelled.
  const escrows = await client.query<{ order_address: string; market: string; lp_mint: string }>(
    `WITH created AS (
      SELECT DISTINCT ON (order_address) order_address,market_address AS market,
        payload->'accounts'->'named'->>'target_hlp_mint' AS lp_mint
      FROM dusk_ingestion.order_instruction_observations
      WHERE cluster=$1 AND program_id=$2 AND idl_hash=$3 AND protocol_revision=$4
        AND instruction_name='create_hlp_order' AND owner_address=$5
      ORDER BY order_address,slot DESC,instruction_path DESC,observation_id DESC
    ), latest AS (
      SELECT DISTINCT ON (o.order_address) o.order_address,o.instruction_name
      FROM dusk_ingestion.order_instruction_observations o JOIN created USING(order_address)
      WHERE o.cluster=$1 AND o.program_id=$2 AND o.idl_hash=$3 AND o.protocol_revision=$4
        AND o.instruction_name IN ('create_hlp_order','cancel_hlp_order','execute_hlp_order','settle_hlp_order_yield')
      ORDER BY o.order_address,o.slot DESC,o.instruction_path DESC,o.observation_id DESC
    )
    SELECT c.order_address,c.market,c.lp_mint FROM created c JOIN latest l USING(order_address)
    WHERE l.instruction_name<>'settle_hlp_order_yield' ORDER BY c.order_address`,
    [...delegate, owner],
  );
  const markets = await client.query<{ market: string; base_mint: string; quote_mint: string; base_hlp_mint: string; quote_hlp_mint: string }>(
    `SELECT market,base_mint,quote_mint,base_hlp_mint,quote_hlp_mint FROM dusk_ingestion.streamed_markets
    WHERE cluster=$1 AND program_id=$2 AND idl_hash=$3 AND protocol_revision=$4 AND market=ANY($5::text[])`,
    [...dusk, [...new Set(escrows.rows.map((row) => row.market))]],
  );
  const stream = await readStreamCursor(client);
  if (!stream) throw Object.assign(new Error('The Dusk stream has not started'), { status: 503 });
  const byMarket = new Map(markets.rows.map((row) => [row.market, row]));
  const groups: YieldGroup[] = holdings.rows.map((row) => ({
    holder: owner,
    market: row.market,
    lpMint: row.lp_mint,
    kind: row.kind === 'ylp' ? 'ylp' : 'hlp',
    baseMint: row.base_mint,
    quoteMint: row.quote_mint,
  }));
  for (const row of escrows.rows) {
    const market = byMarket.get(row.market);
    if (!market || ![market.base_hlp_mint, market.quote_hlp_mint].includes(row.lp_mint))
      throw new Error('hLP order escrow names an unknown vault');
    groups.push({ holder: row.order_address, market: row.market, lpMint: row.lp_mint, kind: 'hlp',
      baseMint: market.base_mint, quoteMint: market.quote_mint });
  }
  if (groups.length > MAX_YIELD_GROUPS) throw new Error('Yield holdings exceed the bounded capture');
  return { groups, sourceSlot: Number(stream.throughSlot) };
}

/** The deployed repair appends a zero Option to the exact pre-authority layout. */
function decodeYield(dusk: Dusk, data: Buffer): YieldAccount {
  return dusk.program.coder.accounts.decode<YieldAccount>(
    'yieldAccount',
    data.length === 234 ? Buffer.concat([data, Buffer.from([0])]) : data,
  );
}

/** One group in one simulated bank. A rejected market preview is `null`. */
export async function captureYieldGroup(
  dusk: Dusk,
  group: YieldGroup,
  payer: string,
  minSlot: number,
  signal?: AbortSignal,
): Promise<YieldStream[] | null> {
  const program = dusk.program.programId;
  const holder = new PublicKey(group.holder),
    market = new PublicKey(group.market),
    lpMint = new PublicKey(group.lpMint);
  const assets = [new PublicKey(group.baseMint), new PublicKey(group.quoteMint)];
  const lpAccount = getAssociatedTokenAddressSync(lpMint, holder, true, TOKEN_2022_PROGRAM_ID);
  const yields = assets.map((asset) => deriveYieldAccountAddress(market, holder, lpMint, asset, group.kind, program)[0]);
  const addresses = [group.market, group.lpMint, lpAccount.toBase58(), ...yields.map(String), ...assets.map(String), SYSVAR_CLOCK_PUBKEY.toBase58()];
  if (new Set(addresses).size !== addresses.length) throw new Error('Duplicate yield source accounts');
  const instruction = await dusk.program.methods
    .previewMarket()
    .accountsStrict({ market })
    .remainingAccounts(addresses.slice(1).map((key) => ({ pubkey: new PublicKey(key), isSigner: false, isWritable: false })))
    .instruction();
  const transaction = new VersionedTransaction(
    new TransactionMessage({
      payerKey: new PublicKey(payer),
      recentBlockhash: PublicKey.default.toBase58(),
      instructions: [
        ComputeBudgetProgram.requestHeapFrame({ bytes: 256 * 1024 }),
        ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
        instruction,
      ],
    }).compileToV0Message(),
  );
  const simulation = await boundedDuskRpcRead(
    () =>
      dusk.program.provider.connection.simulateTransaction(transaction, {
        sigVerify: false,
        replaceRecentBlockhash: true,
        commitment: 'confirmed',
        minContextSlot: minSlot,
        accounts: { encoding: 'base64', addresses },
      }),
    signal,
  );
  const slot = simulation.context.slot,
    result = simulation.value;
  if (!Number.isSafeInteger(slot) || slot < minSlot) throw new Error('Yield preview is behind its discovery');
  if (result.err) return null;
  if (
    result.accounts?.length !== addresses.length ||
    result.returnData?.programId !== program.toBase58() ||
    result.returnData.data[1] !== 'base64' ||
    decodePreviewMarketReturnData(result.returnData.data).slot.toString() !== String(slot)
  )
    throw new Error('Yield preview returned incomplete program data');
  const infos = result.accounts.map((value): AccountInfo<Buffer> | null => {
    if (!value) return null;
    if (value.executable || value.data[1] !== 'base64' || Buffer.from(value.data[0], 'base64').toString('base64') !== value.data[0])
      throw new Error('Invalid yield snapshot encoding');
    return { ...value, owner: new PublicKey(value.owner), data: Buffer.from(value.data[0], 'base64') };
  });
  const owned = (info: AccountInfo<Buffer> | null, owner: PublicKey) => {
    if (!info || !info.owner.equals(owner)) throw new Error('Invalid yield source account');
    return info;
  };
  const state = dusk.program.coder.accounts.decode<Market>('market', owned(infos[0], program).data);
  const clock = infos[7];
  if (
    !clock ||
    clock.owner.toBase58() !== CLOCK_OWNER ||
    clock.data.length !== 40 ||
    clock.data.readBigUInt64LE(0) !== BigInt(slot) ||
    state.version !== 1 ||
    !state.baseSide.assetMint.equals(assets[0]) ||
    !state.quoteSide.assetMint.equals(assets[1]) ||
    (group.kind === 'ylp' ? !state.ylpMint.equals(lpMint) : !state.baseSide.hlpMint.equals(lpMint) && !state.quoteSide.hlpMint.equals(lpMint))
  )
    throw new Error('Yield market, LP mint or bank changed');
  const lp = unpackMint(lpMint, owned(infos[1], TOKEN_2022_PROGRAM_ID), TOKEN_2022_PROGRAM_ID);
  if (!lp.isInitialized || !lp.mintAuthority?.equals(market)) throw new Error('Invalid yield LP mint');
  const token = infos[2] ? unpackAccount(lpAccount, owned(infos[2], TOKEN_2022_PROGRAM_ID), TOKEN_2022_PROGRAM_ID) : null;
  if (token && (!token.isInitialized || !token.owner.equals(holder) || !token.mint.equals(lpMint) || token.amount > lp.supply))
    throw new Error('Invalid yield LP holding');
  const balance = token?.amount ?? 0n,
    epoch = clock.data.readBigUInt64LE(16);
  const size = dusk.program.coder.accounts.size('yieldAccount');
  return assets.map((assetMint, index) => {
    const mintInfo = infos[5 + index];
    if (!mintInfo || (!mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID) && !mintInfo.owner.equals(TOKEN_PROGRAM_ID)))
      throw new Error('Invalid yield asset mint');
    const mint = unpackMint(assetMint, mintInfo, mintInfo.owner);
    if (!mint.isInitialized || mint.decimals !== (index === 0 ? state.baseSide : state.quoteSide).assetDecimals)
      throw new Error('Yield token decimals changed');
    const info = infos[3 + index];
    const account = info ? decodeYield(dusk, owned(info, program).data) : null;
    if (
      account &&
      (!account.owner.equals(holder) || !account.market.equals(market) || !account.lpMint.equals(lpMint) ||
        !account.assetMint.equals(assetMint) || account.tokenKind !== (group.kind === 'ylp' ? 0 : 1) ||
        account.recipient.equals(PublicKey.default))
    )
      throw new Error('Yield account identity changed');
    const amounts = account ? projectLiveYield(state, account, balance) : { swapFeeAmount: 0n, interestAmount: 0n, totalAmount: 0n };
    const fees = getTransferFeeConfig(mint);
    const fee = (amount: bigint) => (fees ? calculateEpochFee(fees, epoch, amount) : 0n);
    return {
      address: yields[index].toBase58(),
      holder: group.holder,
      market: group.market,
      lpMint: group.lpMint,
      assetMint: assetMint.toBase58(),
      kind: group.kind,
      recipient: account?.recipient.toBase58() ?? group.holder,
      initialized: account !== null,
      needsGrowth: info !== null && info.data.length < size,
      lpBalance: balance.toString(),
      lpDecimals: lp.decimals,
      assetDecimals: mint.decimals,
      swapFeeAmount: amounts.swapFeeAmount.toString(),
      interestAmount: amounts.interestAmount.toString(),
      recipientCredit: (amounts.totalAmount - fee(amounts.swapFeeAmount) - fee(amounts.interestAmount)).toString(),
      sourceSlot: slot,
    };
  });
}

export const ownerYieldDependencies = { groups: readOwnerYieldGroups, group: captureYieldGroup };

export async function captureOwnerYield(
  dusk: Dusk,
  owner: string,
  deployment: DuskDeploymentEnvelope,
  signal?: AbortSignal,
  deps = ownerYieldDependencies,
) {
  const observedAt = Date.now();
  const payer = process.env.DUSK_PREVIEW_PAYER?.trim() || deployment.programUpgradeAuthority;
  const { groups, sourceSlot } = await deps.groups(owner);
  if (groups.length && !payer) throw new Error('A read-only preview payer must be configured');
  const floor = Math.max(deployment.sourceSlot, sourceSlot);
  const valued = await completeBatch(groups, (group) => deps.group(dusk, group, payer!, floor, signal), 3);
  signal?.throwIfAborted();
  if (Date.now() >= observedAt + 15_000) throw new Error('Yield capture expired');
  const streams = valued.flatMap((rows) => rows ?? []);
  return {
    schemaVersion: 'dusk-owner-yield.v1' as const,
    owner,
    observedAt,
    expiresAt: observedAt + 15_000,
    sourceSlot: Math.max(sourceSlot, ...streams.map((row) => row.sourceSlot)),
    streams,
    // A market whose preview the program rejects has unknown yield, not zero.
    unavailable: groups
      .filter((_, index) => valued[index] === null)
      .map((group) => ({ holder: group.holder, market: group.market, lpMint: group.lpMint })),
  };
}

export function currentOwnerYield(owner: string) {
  return currentDisplayState(`yield:${owner}`, async (deployment) => {
    const { dusk } = await displayRuntime();
    return captureWithDeadline((signal) => captureOwnerYield(dusk, owner, deployment, signal));
  });
}
