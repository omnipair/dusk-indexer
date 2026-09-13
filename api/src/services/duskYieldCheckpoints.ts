import { BorshAccountsCoder, Idl } from '@coral-xyz/anchor';
import { AccountInfo, Connection, PublicKey } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, unpackAccount } from '@solana/spl-token';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PoolClient } from 'pg';
import pool from '../config/database';
import { canonicalJson, duskApiConfig, loadPinnedProtocol, sha256 } from '../config/duskProtocol';
import { deploymentEnvelope } from './duskDeploymentService';
import { readFinalizedBlock } from './duskFinalizedBlock';
import { projectRecordedYield, yieldBindings } from './duskYieldCheckpointMath';

const identity = () => {
  const pin = loadPinnedProtocol();
  return [pin.cluster,pin.dusk.programId,pin.dusk.idlCanonicalSha256,pin.revision];
};
function coder() {
  loadPinnedProtocol(); // Verify IDL bytes before constructing the decoder.
  const root = process.env.DUSK_PROTOCOL_DIR?.trim() || resolve(__dirname,'../../../protocol');
  return new BorshAccountsCoder(JSON.parse(readFileSync(resolve(root,'idl/dusk.json'),'utf8')) as Idl);
}

interface RawInfo { owner: string; executable: boolean; data: string }
export interface YieldCheckpointSource {
  yieldAddress: string; market: string; lpTokenAccount: string; slot: number; blockhash: string; blockTime: string;
  deploymentIdentitySha256: string;
  accounts: { yield: RawInfo | null; market: RawInfo | null; lpToken: RawInfo | null };
}
function raw(info: AccountInfo<Buffer> | null): RawInfo | null {
  return info ? { owner: info.owner.toBase58(),executable: info.executable,data: info.data.toString('base64') } : null;
}
function account(info: RawInfo | null, owner: string): AccountInfo<Buffer> {
  if (!info || info.owner !== owner || info.executable) throw new Error('Yield checkpoint account is missing or has the wrong owner');
  const data = Buffer.from(info.data,'base64');
  if (data.toString('base64') !== info.data) throw new Error('Invalid yield checkpoint account bytes');
  return { owner: new PublicKey(info.owner),executable: false,data,lamports: 0,rentEpoch: 0 };
}

/** Persisted before decoding/projecting, including contradictory finalized evidence. */
export async function storeYieldCheckpointSource(client: PoolClient, source: YieldCheckpointSource): Promise<string> {
  const active = identity();
  if (!Number.isSafeInteger(source.slot) || source.slot<0 || !Number.isFinite(Date.parse(source.blockTime))) throw new Error('Invalid yield checkpoint source coordinates');
  source = { ...source,blockTime: new Date(source.blockTime).toISOString() };
  const contentHash = sha256(canonicalJson([active,source]));
  const values = [...active,source.yieldAddress,source.market,source.lpTokenAccount,source.slot,source.blockhash,source.blockTime,
    source.deploymentIdentitySha256,JSON.stringify(source.accounts),contentHash];
  const result = await client.query<{ observation_id: string }>(`INSERT INTO dusk_ingestion.yield_checkpoint_observations
    (cluster,program_id,idl_hash,protocol_revision,yield_account,market,lp_token_account,slot,blockhash,block_time,
     deployment_identity_sha256,source_accounts,content_hash)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    ON CONFLICT(cluster,program_id,idl_hash,protocol_revision,yield_account,slot,content_hash) DO NOTHING RETURNING observation_id::text`, values);
  if (result.rows[0]) return result.rows[0].observation_id;
  const previous = await client.query<{ observation_id: string }>(`SELECT observation_id::text FROM dusk_ingestion.yield_checkpoint_observations
    WHERE cluster=$1 AND program_id=$2 AND idl_hash=$3 AND protocol_revision=$4 AND yield_account=$5 AND slot=$6 AND content_hash=$7`,
    [...active,source.yieldAddress,source.slot,contentHash]);
  if (!previous.rows[0]) throw new Error('FINALIZED_INVARIANT: yield checkpoint source disappeared');
  return previous.rows[0].observation_id;
}

/** Caller owns a transaction; replay consumes the same immutable observation. */
export async function projectYieldCheckpoint(client: PoolClient, observationId: string) {
  const active = identity();
  const result = await client.query(`SELECT *,slot::text FROM dusk_ingestion.yield_checkpoint_observations
    WHERE cluster=$1 AND program_id=$2 AND idl_hash=$3 AND protocol_revision=$4 AND observation_id=$5`, [...active,observationId]);
  if (!result.rows[0]) throw new Error('Yield checkpoint observation is not in the active protocol identity');
  const row = result.rows[0];
  const source: YieldCheckpointSource = { yieldAddress: row.yield_account,market: row.market,lpTokenAccount: row.lp_token_account,
    slot: Number(row.slot),blockhash: row.blockhash,blockTime: (row.block_time as Date).toISOString(),
    deploymentIdentitySha256: row.deployment_identity_sha256,accounts: row.source_accounts };
  if (!Number.isSafeInteger(source.slot) || sha256(canonicalJson([active,source])) !== row.content_hash)
    throw new Error('FINALIZED_INVARIANT: stored yield checkpoint evidence hash differs');
  const decoder = coder();
  const yieldInfo = account(source.accounts.yield,active[1]), marketInfo = account(source.accounts.market,active[1]);
  const yieldState = decoder.decode('YieldAccount',yieldInfo.data), marketState = decoder.decode('Market',marketInfo.data);
  const bound = yieldBindings(yieldState);
  if (bound.market !== source.market || bound.lpTokenAccount !== source.lpTokenAccount) throw new Error('Yield checkpoint bindings changed across discovery and capture');
  const lpInfo = source.accounts.lpToken ? account(source.accounts.lpToken,TOKEN_2022_PROGRAM_ID.toBase58()) : null;
  let balance = '0';
  if (lpInfo) {
    const token = unpackAccount(new PublicKey(source.lpTokenAccount),lpInfo,TOKEN_2022_PROGRAM_ID);
    if (!token.isInitialized || token.owner.toBase58() !== bound.owner || token.mint.toBase58() !== bound.lpMint)
      throw new Error('LP account does not match the yield owner and mint');
    balance = token.amount.toString();
  }
  const projected = projectRecordedYield({ programId: active[1],yieldAddress: source.yieldAddress,yield: yieldState,
    market: marketState,lpTokenAccount: source.lpTokenAccount,lpBalance: balance });
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`yield-checkpoint:${JSON.stringify(active)}:${source.yieldAddress}`]);
  const previous = await client.query(`SELECT content_hash FROM dusk_ingestion.yield_checkpoints
    WHERE cluster=$1 AND program_id=$2 AND idl_hash=$3 AND protocol_revision=$4 AND yield_account=$5 AND slot=$6`, [...active,source.yieldAddress,source.slot]);
  if (previous.rows[0]) {
    if (previous.rows[0].content_hash !== row.content_hash) throw new Error('FINALIZED_INVARIANT: conflicting finalized yield checkpoint');
    return projected;
  }
  await client.query(`INSERT INTO dusk_ingestion.yield_checkpoints
    (cluster,program_id,idl_hash,protocol_revision,yield_account,owner,market,lp_mint,asset_mint,token_kind,slot,blockhash,block_time,
     lp_balance,swap_fee_amount,interest_amount,swap_remainder_q64,interest_remainder_q64,raw_yield,raw_market,raw_lp_account,
     content_hash,observation_id,lp_token_account,asset_decimals,deployment_identity_sha256)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)`,
    [...active,source.yieldAddress,projected.owner,source.market,projected.lpMint,projected.assetMint,projected.tokenKind,
      source.slot,source.blockhash,source.blockTime,projected.lpBalance,projected.swapFeeAmount,projected.interestAmount,
      projected.swapRemainderQ64,projected.interestRemainderQ64,yieldInfo.data,marketInfo.data,lpInfo?.data ?? null,
      row.content_hash,observationId,source.lpTokenAccount,projected.assetDecimals,source.deploymentIdentitySha256]);
  return projected;
}

/** Caller owns a transaction; persisted observations survive a rejected batch. */
export async function projectYieldCheckpointBatch(client: PoolClient, limit = 500): Promise<number> {
  if (!Number.isSafeInteger(limit) || limit<1 || limit>500) throw new Error('Invalid yield checkpoint batch limit');
  const active = identity();
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`dusk:yield-checkpoints:${JSON.stringify(active)}`]);
  const sources = await client.query<{ observation_id: string }>(`SELECT o.observation_id::text
    FROM dusk_ingestion.yield_checkpoint_observations o
    WHERE cluster=$1 AND program_id=$2 AND idl_hash=$3 AND protocol_revision=$4
      AND NOT EXISTS (SELECT 1 FROM dusk_ingestion.yield_checkpoints p WHERE p.observation_id=o.observation_id)
    ORDER BY o.slot,o.observation_id LIMIT $5`,[...active,limit]);
  for (const row of sources.rows) await projectYieldCheckpoint(client,row.observation_id);
  return sources.rows.length;
}

export async function replayYieldCheckpoints(limit = 500): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const count = await projectYieldCheckpointBatch(client,limit);
    await client.query('COMMIT');
    return count;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

export async function captureDuskYieldCheckpoints() {
  const active = identity(), rpc = new Connection(duskApiConfig().rpcUrl,'finalized'), decoder = coder();
  const initial = await deploymentEnvelope(0,{ fresh: true });
  const minimumSlot = Math.max(Number(initial.programDataSlot),Number(initial.leverageDelegateProgramDataSlot));
  if (!Number.isSafeInteger(minimumSlot) || minimumSlot<0) throw new Error('Invalid deployment slot');
  const discovery = await rpc.getProgramAccounts(new PublicKey(active[1]),{ withContext: true,commitment: 'finalized',minContextSlot: minimumSlot,
    filters: [{ memcmp: decoder.memcmp('YieldAccount') }] });
  if (!Number.isSafeInteger(discovery.context.slot) || discovery.context.slot<minimumSlot) throw new Error('Yield discovery regressed behind the deployment');
  const discoveredIdentity = await deploymentEnvelope(discovery.context.slot,{ fresh: true });
  if (discoveredIdentity.deploymentIdentitySha256 !== initial.deploymentIdentitySha256) throw new Error('Deployment changed during yield discovery');
  const seen = new Set<string>();
  let captured = 0;
  for (const entry of discovery.value) {
    const address = entry.pubkey.toBase58();
    if (seen.has(address)) throw new Error('Duplicate yield account in complete discovery');
    seen.add(address);
    const bound = yieldBindings(decoder.decode('YieldAccount',entry.account.data));
    const before = await deploymentEnvelope(0,{ fresh: true });
    if (before.deploymentIdentitySha256 !== initial.deploymentIdentitySha256) throw new Error('Deployment changed after yield discovery');
    // One RPC request supplies all coupled balances and indexes at one bank.
    const response = await rpc.getMultipleAccountsInfoAndContext([entry.pubkey,new PublicKey(bound.market),new PublicKey(bound.lpTokenAccount)],
      { commitment: 'finalized',minContextSlot: discovery.context.slot });
    if (!Number.isSafeInteger(response.context.slot) || response.context.slot<discovery.context.slot || response.value.length !== 3) throw new Error('Incomplete or regressed yield checkpoint read');
    const block = await readFinalizedBlock(rpc,response.context.slot);
    const after = await deploymentEnvelope(response.context.slot,{ fresh: true });
    if (after.deploymentIdentitySha256 !== before.deploymentIdentitySha256) throw new Error('Deployment changed during yield checkpoint read');
    const source: YieldCheckpointSource = { yieldAddress: address,market: bound.market,lpTokenAccount: bound.lpTokenAccount,
      slot: response.context.slot,blockhash: block.blockhash,blockTime: new Date(block.blockTime*1000).toISOString(),
      deploymentIdentitySha256: after.deploymentIdentitySha256,
      accounts: { yield: raw(response.value[0]),market: raw(response.value[1]),lpToken: raw(response.value[2]) } };
    const client = await pool.connect();
    try {
      // Autocommit the raw observation before starting its projection transaction.
      const observationId = await storeYieldCheckpointSource(client,source);
      await client.query('BEGIN');
      await projectYieldCheckpoint(client,observationId);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
    captured++;
  }
  return { discovered: discovery.value.length,captured,discoverySlot: discovery.context.slot,basis: 'recorded-growth.v1' as const };
}

export interface YieldCheckpointQuery { owner: string; market?: string; limit: number; offset: number }

export async function readYieldCheckpoints(client: PoolClient, options: YieldCheckpointQuery) {
  const active = identity(), values: unknown[] = [...active,new PublicKey(options.owner).toBase58()];
  const filters = ['cluster=$1','program_id=$2','idl_hash=$3','protocol_revision=$4','owner=$5'];
  if (options.market) { values.push(new PublicKey(options.market).toBase58()); filters.push(`market=$${values.length}`); }
  const conflicts = await client.query(`SELECT 1 FROM dusk_ingestion.yield_checkpoint_observations
    WHERE cluster=$1 AND program_id=$2 AND idl_hash=$3 AND protocol_revision=$4
    GROUP BY yield_account,slot HAVING count(DISTINCT content_hash)>1 LIMIT 1`,active);
  if (conflicts.rowCount) throw Object.assign(new Error('FINALIZED_INVARIANT: contradictory finalized yield observations require reconciliation'),{ status: 503 });
  const where = filters.join(' AND ');
  const summary = await client.query(`SELECT count(*)::text AS total,min(slot)::text AS first_slot,max(slot)::text AS last_slot,
    min(block_time) AS first_time,max(block_time) AS last_time FROM dusk_ingestion.yield_checkpoints WHERE ${where}`,values);
  const result = await client.query(`SELECT yield_account,owner,market,lp_mint,asset_mint,token_kind,lp_token_account,asset_decimals,
    lp_balance::text,swap_fee_amount::text,interest_amount::text,swap_remainder_q64::text,interest_remainder_q64::text,
    slot::text,blockhash,block_time,observed_at,observation_id::text,deployment_identity_sha256,basis
    FROM dusk_ingestion.yield_checkpoints WHERE ${where} ORDER BY slot DESC,yield_account
    LIMIT $${values.length+1} OFFSET $${values.length+2}`,[...values,options.limit,options.offset]);
  const pending = await client.query(`SELECT count(*)::text AS total FROM dusk_ingestion.yield_checkpoint_observations o
    WHERE cluster=$1 AND program_id=$2 AND idl_hash=$3 AND protocol_revision=$4
      AND NOT EXISTS (SELECT 1 FROM dusk_ingestion.yield_checkpoints p WHERE p.observation_id=o.observation_id)`,active);
  const provenance = { cluster: active[0],programId: active[1],idlSha256: active[2],protocolRevision: active[3],commitment: 'finalized' as const };
  return {
    checkpoints: result.rows.map((row) => ({ yieldAccount: row.yield_account,owner: row.owner,market: row.market,lpMint: row.lp_mint,
      assetMint: row.asset_mint,tokenKind: row.token_kind === 0 ? 'ylp' as const : 'hlp' as const,assetDecimals: row.asset_decimals,
      lpTokenAccount: row.lp_token_account,lpBalance: row.lp_balance,swapFeeAmount: row.swap_fee_amount,interestAmount: row.interest_amount,
      swapRemainderQ64: row.swap_remainder_q64,interestRemainderQ64: row.interest_remainder_q64,basis: row.basis,
      blockTime: (row.block_time as Date).toISOString(),
      provenance: { ...provenance,sourceSlot: row.slot,blockhash: row.blockhash,observationId: row.observation_id,
        deploymentIdentitySha256: row.deployment_identity_sha256,observedAt: (row.observed_at as Date).toISOString() } })),
    pagination: { limit: options.limit,offset: options.offset,total: Number(summary.rows[0].total) },
    coverage: { ...provenance,basis: 'recorded-growth.v1' as const,historyComplete: false as const,currentHarvestPreviewIncluded: false as const,
      firstSourceSlot: summary.rows[0].first_slot as string | null,lastSourceSlot: summary.rows[0].last_slot as string | null,
      firstCheckpointAt: (summary.rows[0].first_time as Date | null)?.toISOString() ?? null,
      lastCheckpointAt: (summary.rows[0].last_time as Date | null)?.toISOString() ?? null,
      pendingProtocolObservations: pending.rows[0].total as string },
  };
}

export async function listYieldCheckpoints(options: YieldCheckpointQuery) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const result = await readYieldCheckpoints(client,options);
    await client.query('COMMIT');
    return result;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
