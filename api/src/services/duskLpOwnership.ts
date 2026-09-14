import { createHash } from 'node:crypto';
import { Connection, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, getTransferHook, TOKEN_2022_PROGRAM_ID, unpackAccount, unpackMint } from '@solana/spl-token';
import pool from '../config/database';
import { duskApiConfig, loadPinnedProtocol } from '../config/duskProtocol';
import { deploymentEnvelope } from './duskDeploymentService';
import { readFinalizedBlock } from './duskFinalizedBlock';
import { assertNativeEvidenceConsistent } from './duskNativeEvidence';

const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const identity = () => {
  const pin = loadPinnedProtocol();
  return [pin.cluster, pin.dusk.programId, pin.dusk.idlCanonicalSha256, pin.revision];
};

interface LpMint { market: string; mint: string; kind: 'ylp' | 'base_hlp' | 'quote_hlp'; sourceSlot: number }
async function discoverLpMints(): Promise<LpMint[]> {
  const active = identity();
  const coverage = await pool.query('SELECT 1 FROM dusk_ingestion.account_scans WHERE cluster=$1 AND program_id=$2 AND idl_hash=$3 AND protocol_revision=$4 AND applied_at IS NOT NULL LIMIT 1', active);
  if (!coverage.rowCount) throw new Error('Native market scan is required before LP ownership scanning');
  const result = await pool.query('SELECT account_pubkey,decoded_fields,source_slot FROM dusk_ingestion.native_markets WHERE cluster=$1 AND program_id=$2 AND idl_hash=$3 AND protocol_revision=$4', active);
  return result.rows.flatMap((row) => [
    { market: row.account_pubkey, mint: row.decoded_fields.ylp_mint, kind: 'ylp' as const, sourceSlot: Number(row.source_slot) },
    { market: row.account_pubkey, mint: row.decoded_fields.base_side.hlp_mint, kind: 'base_hlp' as const, sourceSlot: Number(row.source_slot) },
    { market: row.account_pubkey, mint: row.decoded_fields.quote_side.hlp_mint, kind: 'quote_hlp' as const, sourceSlot: Number(row.source_slot) },
  ]);
}

/** Native token snapshots include transfers, non-ATAs, authority changes and closures. */
export async function captureDuskLpOwnership(): Promise<{ mints: number; accounts: number }> {
  const rpc = new Connection(duskApiConfig().rpcUrl, 'finalized');
  const mints = await discoverLpMints();
  let accounts = 0;
  for (const mint of mints) {
    const before = await deploymentEnvelope(0, { fresh: true });
    const result = await rpc.getProgramAccounts(TOKEN_2022_PROGRAM_ID, {
      commitment: 'finalized', withContext: true, minContextSlot: mint.sourceSlot,
      filters: [{ memcmp: { offset: 0, bytes: mint.mint } }],
    });
    if (result.context.slot < mint.sourceSlot) throw new Error('LP ownership scan regressed behind market discovery');
    const mintKey = new PublicKey(mint.mint);
    const mintInfo = await rpc.getAccountInfoAndContext(mintKey, { commitment: 'finalized', minContextSlot: result.context.slot });
    if (mintInfo.context.slot < result.context.slot) throw new Error('LP mint read regressed');
    const state = unpackMint(mintKey, mintInfo.value, TOKEN_2022_PROGRAM_ID);
    const hook = getTransferHook(state);
    if (!state.mintAuthority?.equals(new PublicKey(mint.market)) || !hook?.programId.equals(new PublicKey(before.programId)))
      throw new Error('LP mint authority or transfer hook does not match its Dusk market');
    const addresses = new Set<string>();
    let total = 0n;
    const rows = result.value.map(({ pubkey, account }) => {
      if (addresses.has(pubkey.toBase58())) throw new Error('Duplicate LP account in complete RPC scan');
      addresses.add(pubkey.toBase58());
      const token = unpackAccount(pubkey, account, TOKEN_2022_PROGRAM_ID);
      if (!token.mint.equals(mintKey) || !token.isInitialized) throw new Error('Invalid LP token account in RPC scan');
      total += token.amount;
      return { token_account: pubkey.toBase58(), owner: token.owner.toBase58(), amount: token.amount.toString(),
        frozen: token.isFrozen, canonical_ata: getAssociatedTokenAddressSync(mintKey, token.owner, true, TOKEN_2022_PROGRAM_ID).equals(pubkey),
        data_hash: hash(account.data), raw_base64: account.data.toString('base64') };
    }).sort((a,b) => a.token_account.localeCompare(b.token_account));
    // A concurrent mint/burn can change supply after the token-account bank.
    // Refuse this capture and retry on the next pass; never scale balances to fit.
    if (total !== state.supply) throw new Error(`LP ownership and mint supply differ for ${mint.mint}; retry a coherent snapshot`);
    const block = await readFinalizedBlock(rpc, result.context.slot);
    if (!block || block.blockTime === null || block.blockTime === undefined) throw new Error('LP scan has no finalized containing block/time');
    const after = await deploymentEnvelope(mintInfo.context.slot, { fresh: true });
    if (before.deploymentIdentitySha256 !== after.deploymentIdentitySha256) throw new Error('Deployment changed during LP ownership scan');
    const contentHash = hash(JSON.stringify([mint.market,mint.mint,mint.kind,state.supply.toString(),state.decimals,rows.map((row) => [row.token_account,row.data_hash])]));
    const client = await pool.connect();
    let scanId: string;
    try {
      await client.query('BEGIN');
      const scan = await client.query<{ scan_id: string }>(`INSERT INTO dusk_ingestion.lp_token_scans
        (cluster,program_id,idl_hash,protocol_revision,market,lp_mint,token_kind,slot,blockhash,parent_slot,block_time,mint_slot,mint_supply,decimals,raw_mint,content_hash,account_count)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
        ON CONFLICT (cluster,program_id,idl_hash,protocol_revision,lp_mint,slot,blockhash) DO UPDATE SET content_hash=EXCLUDED.content_hash
        WHERE dusk_ingestion.lp_token_scans.content_hash=EXCLUDED.content_hash AND dusk_ingestion.lp_token_scans.parent_slot=EXCLUDED.parent_slot
        RETURNING scan_id::text`, [...identity(),mint.market,mint.mint,mint.kind,result.context.slot,block.blockhash,block.parentSlot,new Date(block.blockTime*1000),mintInfo.context.slot,state.supply.toString(),state.decimals,mintInfo.value!.data,contentHash,rows.length]);
      if (!scan.rows[0]) throw new Error('FINALIZED_INVARIANT: conflicting finalized LP token snapshot');
      scanId = scan.rows[0].scan_id;
      await client.query(`INSERT INTO dusk_ingestion.lp_token_observations (scan_id,token_account,owner,amount,frozen,canonical_ata,data_hash,raw_account)
        SELECT $1,d->>'token_account',d->>'owner',(d->>'amount')::numeric,(d->>'frozen')::boolean,(d->>'canonical_ata')::boolean,d->>'data_hash',decode(d->>'raw_base64','base64')
        FROM jsonb_array_elements($2::jsonb) d ON CONFLICT DO NOTHING`, [scanId,JSON.stringify(rows)]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
    // Commit observations before projection, retaining replay evidence on failure.
    await pool.query('SELECT dusk_ingestion.apply_lp_token_scan($1)', [scanId]);
    accounts += rows.length;
  }
  return { mints: mints.length, accounts };
}

export async function listDuskLpOwnership(options: { owner?: string; market?: string; limit: number; offset: number }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const active = identity();
    await assertNativeEvidenceConsistent(client,active);
    const scans = await client.query(`SELECT market,lp_mint,token_kind,slot::text,blockhash,block_time,observed_at
      FROM dusk_ingestion.latest_lp_token_scans WHERE cluster=$1 AND program_id=$2 AND idl_hash=$3 AND protocol_revision=$4`, active);
    const markets = await client.query(`SELECT account_pubkey, decoded_fields FROM dusk_ingestion.native_markets
      WHERE cluster=$1 AND program_id=$2 AND idl_hash=$3 AND protocol_revision=$4`, active);
    const wanted = markets.rows.filter((row) => !options.market || row.account_pubkey === options.market);
    const indexedMints = new Set(scans.rows.map((row) => `${row.market}:${row.lp_mint}`));
    if (wanted.length === 0 || wanted.some((row) => [row.decoded_fields.ylp_mint,row.decoded_fields.base_side.hlp_mint,row.decoded_fields.quote_side.hlp_mint].some((mint) => !indexedMints.has(`${row.account_pubkey}:${mint}`))))
      throw Object.assign(new Error('LP ownership coverage is incomplete for the requested markets'), { status: 503 });
    const values: unknown[] = [...active];
    const where = ['cluster=$1','program_id=$2','idl_hash=$3','protocol_revision=$4','amount>0'];
    if (options.owner) { values.push(options.owner); where.push(`owner=$${values.length}`); }
    if (options.market) { values.push(options.market); where.push(`market=$${values.length}`); }
    const count = await client.query(`SELECT count(*)::text AS total FROM dusk_ingestion.native_lp_ownership WHERE ${where.join(' AND ')}`, values);
    const result = await client.query(`SELECT market,lp_mint,token_kind,token_account,owner,amount::text,frozen,canonical_ata,decimals,
      source_slot::text,blockhash,block_time,observed_at FROM dusk_ingestion.native_lp_ownership WHERE ${where.join(' AND ')}
      ORDER BY market,lp_mint,token_account LIMIT $${values.length+1} OFFSET $${values.length+2}`, [...values,options.limit,options.offset]);
    await client.query('COMMIT');
    const relevantScans = scans.rows.filter((row) => !options.market || row.market === options.market);
    return { accounts: result.rows, pagination: { limit: options.limit, offset: options.offset, total: Number(count.rows[0].total) },
      coverage: { cluster: active[0], programId: active[1], idlSha256: active[2], protocolRevision: active[3], commitment: 'finalized',
        complete: true, sourceSlot: Math.min(...relevantScans.map((row) => Number(row.slot))), scans: relevantScans,
        history: 'point-in-time-ownership-snapshots' as const },
      envelopeSourceSlot: Math.max(...relevantScans.map((row) => Number(row.slot))) };
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
