import { BorshCoder, Idl } from '@coral-xyz/anchor';
import { Connection, PublicKey } from '@solana/web3.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PoolClient } from 'pg';
import pool from '../config/database';
import { canonicalJson, duskApiConfig, loadPinnedProtocol, sha256 } from '../config/duskProtocol';
import { deploymentEnvelope } from './duskDeploymentService';
import { parsePriceReferences, priceMarketBindings, projectMarketPrices } from './duskPriceMath';
import { captureMarketSimulation } from './duskMarketSimulation';
import { storeCaptureDeployment } from './duskHistoryDeployment';

const identity = () => {
  const pin = loadPinnedProtocol();
  return [pin.cluster,pin.dusk.programId,pin.dusk.idlCanonicalSha256,pin.revision];
};
const protocolRoot = () => process.env.DUSK_PROTOCOL_DIR?.trim() || resolve(__dirname,'../../../protocol');
function idl(): Idl {
  loadPinnedProtocol();
  return JSON.parse(readFileSync(resolve(protocolRoot(),'idl/dusk.json'),'utf8')) as Idl;
}
export interface PriceCaptureSource {
  market: string; slot: number; marketSlot: number; blockhash: string; blockTime: string; observedAt: string;
  deploymentIdentitySha256: string; rawMarket: string; rawPreview: string; references: unknown;
  marketStateBasis?: 'simulation-post-state';
}
function hashSource(source: PriceCaptureSource): string {
  // Repeat observations of identical bank bytes retain their first capture.
  const { observedAt: _observedAt,...durable } = source;
  return sha256(canonicalJson([identity(),durable]));
}
function bytes(value: string): Buffer {
  const result = Buffer.from(value,'base64');
  if (!result.length || result.toString('base64') !== value) throw new Error('Invalid price source bytes');
  return result;
}
export async function storePriceCapture(client: PoolClient, input: PriceCaptureSource): Promise<string> {
  if (!Number.isSafeInteger(input.slot) || !Number.isSafeInteger(input.marketSlot) || input.marketSlot<0 || input.slot<input.marketSlot)
    throw new Error('Invalid price capture slots');
  if (input.marketStateBasis !== undefined && (input.marketStateBasis !== 'simulation-post-state' || input.marketSlot !== input.slot))
    throw new Error('Simulated market state must share the preview slot');
  const source = { ...input,blockTime: new Date(input.blockTime).toISOString(),observedAt: new Date(input.observedAt).toISOString() };
  const rawMarket = bytes(source.rawMarket),rawPreview = bytes(source.rawPreview),contentHash = hashSource(source);
  const result = await client.query<{ capture_id: string }>(`INSERT INTO dusk_ingestion.price_capture_observations
    (cluster,program_id,idl_hash,protocol_revision,market,slot,market_slot,blockhash,block_time,observed_at,
     deployment_identity_sha256,raw_market,raw_preview,reference_config,content_hash,preview_hash,market_state_basis)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
    ON CONFLICT(cluster,program_id,idl_hash,protocol_revision,market,slot,content_hash) DO NOTHING RETURNING capture_id::text`,
    [...identity(),source.market,source.slot,source.marketSlot,source.blockhash,source.blockTime,source.observedAt,
      source.deploymentIdentitySha256,rawMarket,rawPreview,JSON.stringify(source.references),contentHash,sha256(rawPreview),source.marketStateBasis ?? 'rpc-account']);
  if (result.rows[0]) return result.rows[0].capture_id;
  const existing = await client.query<{ capture_id: string }>(`SELECT capture_id::text FROM dusk_ingestion.price_capture_observations
    WHERE cluster=$1 AND program_id=$2 AND idl_hash=$3 AND protocol_revision=$4 AND market=$5 AND slot=$6 AND content_hash=$7`,
    [...identity(),source.market,source.slot,contentHash]);
  if (!existing.rows[0]) throw new Error('FINALIZED_INVARIANT: saved price source disappeared');
  return existing.rows[0].capture_id;
}

export async function assertNoPriceConflict(client: PoolClient) {
  const conflicts = await client.query(`SELECT 1 FROM dusk_ingestion.price_capture_observations
    WHERE cluster=$1 AND program_id=$2 AND idl_hash=$3 AND protocol_revision=$4
    GROUP BY market,slot HAVING count(DISTINCT (blockhash,preview_hash,block_time))>1 LIMIT 1`,identity());
  if (conflicts.rowCount) throw Object.assign(new Error('FINALIZED_INVARIANT: contradictory finalized market price previews'),{ status: 503 });
}

export interface StoredPriceCapture {
  cluster: string; program_id: string; idl_hash: string; protocol_revision: string;
  capture_id: string; market: string; slot: string; market_slot: string; blockhash: string;
  block_time: Date; observed_at: Date; deployment_identity_sha256: string;
  raw_market: Buffer; raw_preview: Buffer; reference_config: unknown; market_state_basis: string;
  content_hash: string; preview_hash: string;
}

/** Rebuild historical price evidence from its immutable saved bytes/policy. */
export function verifyStoredPriceCapture(row: StoredPriceCapture) {
  if (JSON.stringify([row.cluster,row.program_id,row.idl_hash,row.protocol_revision]) !== JSON.stringify(identity())
    || !['rpc-account','simulation-post-state'].includes(row.market_state_basis)) throw new Error('Price capture differs from the active protocol identity');
  const source: PriceCaptureSource = { market: row.market,slot: Number(row.slot),marketSlot: Number(row.market_slot),blockhash: row.blockhash,
    blockTime: row.block_time.toISOString(),observedAt: row.observed_at.toISOString(),deploymentIdentitySha256: row.deployment_identity_sha256,
    rawMarket: row.raw_market.toString('base64'),rawPreview: row.raw_preview.toString('base64'),references: row.reference_config,
    ...(row.market_state_basis === 'simulation-post-state' ? { marketStateBasis: 'simulation-post-state' as const } : {}) };
  if (!Number.isSafeInteger(source.slot) || !Number.isSafeInteger(source.marketSlot) || source.marketSlot<0 || source.slot<source.marketSlot
    || source.marketStateBasis === 'simulation-post-state' && source.slot !== source.marketSlot
    || Date.parse(source.observedAt)<Date.parse(source.blockTime) || hashSource(source) !== row.content_hash
    || sha256(row.raw_preview) !== row.preview_hash) throw new Error('FINALIZED_INVARIANT: saved price source hash mismatch');
  const decoder = new BorshCoder(idl());
  const projected = projectMarketPrices({ pin: loadPinnedProtocol(),marketAddress: source.market,market: decoder.accounts.decode('Market',row.raw_market),
    preview: decoder.types.decode('MarketPreview',row.raw_preview),slot: source.slot,blockTime: source.blockTime,references: source.references });
  return { source,projected };
}

/** Caller owns a transaction. Projection uses only the saved policy and bytes. */
export async function projectPriceCapture(client: PoolClient, captureId: string): Promise<number> {
  const active = identity();
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`dusk:prices:${JSON.stringify(active)}`]);
  await assertNoPriceConflict(client);
  const result = await client.query<StoredPriceCapture>(`SELECT *,slot::text,market_slot::text,capture_id::text FROM dusk_ingestion.price_capture_observations
    WHERE cluster=$1 AND program_id=$2 AND idl_hash=$3 AND protocol_revision=$4 AND capture_id=$5`,[...active,captureId]);
  const row = result.rows[0];
  if (!row) throw new Error('Price capture is not in the active protocol identity');
  const { source,projected } = verifyStoredPriceCapture(row);
  const quote = [captureId,projected.bound.baseMint,projected.bound.quoteMint,projected.bound.baseDecimals,
    projected.bound.quoteDecimals,projected.spotPrices.base,projected.spotPrices.quote];
  await client.query(`INSERT INTO dusk_ingestion.market_quote_projections
    (capture_id,base_mint,quote_mint,base_decimals,quote_decimals,base_spot_price_nad,quote_spot_price_nad)
    VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(capture_id) DO NOTHING`,quote);
  const sameQuote = await client.query(`SELECT 1 FROM dusk_ingestion.market_quote_projections
    WHERE capture_id=$1 AND base_mint=$2 AND quote_mint=$3 AND base_decimals=$4 AND quote_decimals=$5
      AND base_spot_price_nad=$6 AND quote_spot_price_nad=$7`,quote);
  if (!sameQuote.rowCount) throw new Error('FINALIZED_INVARIANT: market quote differs from its saved preview');
  const previous = await client.query<{ price_count: number }>('SELECT price_count FROM dusk_ingestion.price_capture_projections WHERE capture_id=$1',[captureId]);
  if (previous.rows[0]) return previous.rows[0].price_count;
  // Multiple finalized slots can share a second. Keep both observations even
  // when the containing block times are equal.
  const sourceName = `dusk-preview.v1:${source.market}:${projected.referenceHash}:${source.slot}`;
  for (const price of projected.prices) {
    const evidence = { captureId,market: source.market,sourceSlot: source.slot.toString(),blockhash: source.blockhash,previewHash: row.preview_hash,
      deploymentIdentitySha256: source.deploymentIdentitySha256,referenceHash: projected.referenceHash,
      reference: price.reference,spotPriceNad: price.spotPriceNad,rounding: 'down-36-decimals',basis: 'program-preview.v1' };
    const inserted = await client.query(`INSERT INTO dusk_ingestion.price_observations
      (cluster,program_id,idl_hash,protocol_revision,mint,decimals,observed_at,source_time,price_usd,quality,source,source_evidence,capture_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      ON CONFLICT(cluster,program_id,idl_hash,protocol_revision,mint,source,source_time) DO NOTHING RETURNING observation_id`,
      [...active,price.mint,price.decimals,source.observedAt,source.blockTime,price.priceUsd,price.quality,sourceName,JSON.stringify(evidence),captureId]);
    if (!inserted.rowCount) {
      const same = await client.query(`SELECT 1 FROM dusk_ingestion.price_observations WHERE cluster=$1 AND program_id=$2 AND idl_hash=$3
        AND protocol_revision=$4 AND mint=$5 AND source=$6 AND source_time=$7 AND price_usd=$8 AND decimals=$9 AND quality=$10
        AND source_evidence->>'previewHash'=$11`,[...active,price.mint,sourceName,source.blockTime,price.priceUsd,price.decimals,price.quality,row.preview_hash]);
      if (!same.rowCount) throw new Error('FINALIZED_INVARIANT: a price source already has a different value');
    }
  }
  await client.query('INSERT INTO dusk_ingestion.price_capture_projections(capture_id,price_count) VALUES($1,$2)',[captureId,projected.prices.length]);
  return projected.prices.length;
}

export async function projectPriceCaptureBatch(client: PoolClient, limit = 100): Promise<number> {
  if (!Number.isSafeInteger(limit) || limit<1 || limit>100) throw new Error('Invalid price replay batch limit');
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`dusk:prices:${JSON.stringify(identity())}`]);
  await assertNoPriceConflict(client);
  const sources = await client.query<{ capture_id: string }>(`SELECT o.capture_id::text FROM dusk_ingestion.price_capture_observations o
    WHERE cluster=$1 AND program_id=$2 AND idl_hash=$3 AND protocol_revision=$4
      AND (NOT EXISTS(SELECT 1 FROM dusk_ingestion.price_capture_projections p WHERE p.capture_id=o.capture_id)
        OR NOT EXISTS(SELECT 1 FROM dusk_ingestion.market_quote_projections q WHERE q.capture_id=o.capture_id))
    ORDER BY o.slot,o.capture_id LIMIT $5`,[...identity(),limit]);
  for (const row of sources.rows) await projectPriceCapture(client,row.capture_id);
  return sources.rows.length;
}
export async function replayPriceCaptures(): Promise<number> {
  const client = await pool.connect();
  try { await client.query('BEGIN'); const count = await projectPriceCaptureBatch(client); await client.query('COMMIT'); return count; }
  catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

export async function captureDuskPrices() {
  const pin = loadPinnedProtocol(),active = identity(),rpc = new Connection(duskApiConfig().rpcUrl,'finalized'),rawIdl = idl();
  const references = parsePriceReferences(JSON.parse(readFileSync(process.env.DUSK_PRICE_REFERENCES_FILE?.trim()
    || resolve(protocolRoot(),'devnet-price-references.json'),'utf8')),pin);
  const decoder = new BorshCoder(rawIdl);
  const initial = await deploymentEnvelope(0,{ fresh: true });
  const floor = Math.max(Number(initial.programDataSlot),Number(initial.leverageDelegateProgramDataSlot));
  if (!Number.isSafeInteger(floor) || floor<0) throw new Error('Invalid price deployment slot');
  const discovery = await rpc.getProgramAccounts(new PublicKey(active[1]),{ commitment: 'finalized',withContext: true,minContextSlot: floor,
    filters: [{ memcmp: decoder.accounts.memcmp('Market') }] });
  if (!Number.isSafeInteger(discovery.context.slot) || discovery.context.slot<floor) throw new Error('Price discovery regressed');
  const discoveredIdentity = await deploymentEnvelope(discovery.context.slot,{ fresh: true });
  if (initial.deploymentIdentitySha256 !== discoveredIdentity.deploymentIdentitySha256) throw new Error('Deployment changed during price discovery');
  let captured = 0,priced = 0;
  const unavailableMarkets: string[] = [],seen = new Set<string>();
  for (const entry of discovery.value) {
    const market = entry.pubkey.toBase58();
    if (seen.has(market) || entry.account.executable || entry.account.owner.toBase58() !== pin.dusk.programId) throw new Error('Invalid complete market price discovery');
    seen.add(market);
    priceMarketBindings(active[1],market,decoder.accounts.decode('Market',entry.account.data));
    const snapshot = await captureMarketSimulation(market,discovery.context.slot);
    if (snapshot.deploymentIdentitySha256 !== initial.deploymentIdentitySha256) throw new Error('Deployment changed after price discovery');
    if (!snapshot.preview) { unavailableMarkets.push(market); continue; }
    const source: PriceCaptureSource = { market,slot: snapshot.slot,marketSlot: snapshot.slot,
      blockhash: snapshot.blockhash,blockTime: snapshot.blockTime,observedAt: snapshot.observedAt,
      deploymentIdentitySha256: snapshot.deploymentIdentitySha256,rawMarket: snapshot.marketAccount.data,rawPreview: snapshot.preview,
      marketStateBasis: 'simulation-post-state',references };
    const client = await pool.connect();
    try {
      await storeCaptureDeployment(client,discoveredIdentity);
      const captureId = await storePriceCapture(client,source);
      await client.query('BEGIN'); priced += await projectPriceCapture(client,captureId); await client.query('COMMIT'); captured++;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  return { discovered: discovery.value.length,captured,priced,unavailableMarkets,discoverySlot: discovery.context.slot };
}

export interface PriceHistoryQuery { mint: string; market?: string; at: string; maxAgeSeconds: number; limit: number; offset: number }
export async function readDuskPriceHistory(client: PoolClient, options: PriceHistoryQuery) {
  if (!Number.isFinite(Date.parse(options.at)) || !Number.isSafeInteger(options.maxAgeSeconds) || options.maxAgeSeconds<1 || options.maxAgeSeconds>86400)
    throw new Error('Invalid price history time range');
  const active = identity();
  await assertNoPriceConflict(client);
  const values: unknown[] = [...active,new PublicKey(options.mint).toBase58(),options.at,options.maxAgeSeconds];
  const where = ['cluster=$1','program_id=$2','idl_hash=$3','protocol_revision=$4','capture_id IS NOT NULL','mint=$5','source_time<=$6::timestamptz',
    "source_time>=$6::timestamptz-($7::int*interval '1 second')"];
  if (options.market) { values.push(new PublicKey(options.market).toBase58()); where.push(`source_evidence->>'market'=$${values.length}`); }
  const filter = where.join(' AND ');
  const count = await client.query(`SELECT count(*)::text AS total FROM dusk_ingestion.price_observations WHERE ${filter}`,values);
  const result = await client.query(`SELECT observation_id::text,mint,decimals,price_usd::text,quality,source,source_time,observed_at,source_evidence
    FROM dusk_ingestion.price_observations WHERE ${filter} ORDER BY source_time DESC,(source_evidence->>'sourceSlot')::bigint DESC,source,observation_id DESC
    LIMIT $${values.length+1} OFFSET $${values.length+2}`,[...values,options.limit,options.offset]);
  const captures = await client.query(`SELECT count(*)::text AS captures,count(p.capture_id)::text AS projected,
    min(o.block_time) AS first_time,max(o.block_time) AS last_time
    FROM dusk_ingestion.price_capture_observations o LEFT JOIN dusk_ingestion.price_capture_projections p USING(capture_id)
    WHERE cluster=$1 AND program_id=$2 AND idl_hash=$3 AND protocol_revision=$4`,active);
  return { observations: result.rows.map((row) => ({ id: row.observation_id,mint: row.mint,decimals: row.decimals,priceUsd: row.price_usd,
    quality: row.quality,source: row.source,sourceTime: row.source_time.toISOString(),observedAt: row.observed_at.toISOString(),
    evidence: row.source_evidence,provenance: { cluster: active[0],programId: active[1],idlSha256: active[2],protocolRevision: active[3],commitment: 'finalized' as const } })),
    pagination: { limit: options.limit,offset: options.offset,total: Number(count.rows[0].total) },
    coverage: { asOf: new Date(options.at).toISOString(),maxAgeSeconds: options.maxAgeSeconds,historyComplete: false,
      available: result.rows.length>0,captures: captures.rows[0].captures,projectedCaptures: captures.rows[0].projected,
      firstCaptureAt: captures.rows[0].first_time?.toISOString() ?? null,lastCaptureAt: captures.rows[0].last_time?.toISOString() ?? null,
      basis: 'configured-and-program-derived-references.v1',historicalBackfillAvailable: false } };
}
export async function listDuskPriceHistory(options: PriceHistoryQuery) {
  const client = await pool.connect();
  try { await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); const result = await readDuskPriceHistory(client,options);
    await client.query('COMMIT'); return result; }
  catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
