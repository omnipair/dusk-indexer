import { PublicKey } from '@solana/web3.js';
import { PoolClient } from 'pg';
import pool from '../config/database';
import { loadPinnedProtocol } from '../config/duskProtocol';
import { deploymentEnvelope } from './duskDeploymentService';
import { externalPriceTargets, fetchExternalPrices, storeExternalPrices } from './duskExternalPrices';
import { storeCaptureDeployment } from './duskHistoryDeployment';
import { activePriceReferences, projectObservedPrices } from './duskPriceMath';

const identity = (pin = loadPinnedProtocol()) => [pin.cluster,pin.dusk.programId,pin.dusk.idlCanonicalSha256,pin.revision];

export interface PriceHistoryQuery { mint: string; market?: string; at: string; maxAgeSeconds: number; limit: number; offset: number }

/** Program-derived USD prices for a mint from every swap snapshot of a market
 * that quotes it within the window, newest first, under the dated reference
 * policy. */
export async function readObservedPriceHistory(client: PoolClient,options: PriceHistoryQuery) {
  if (!Number.isFinite(Date.parse(options.at)) || !Number.isSafeInteger(options.maxAgeSeconds) || options.maxAgeSeconds<1 || options.maxAgeSeconds>86400)
    throw new Error('Invalid price history time range');
  const pin = loadPinnedProtocol(),active = identity(pin),mint = new PublicKey(options.mint).toBase58();
  const values: unknown[] = [...active,mint,new Date(options.at).toISOString(),options.maxAgeSeconds];
  const where = [`cluster=$1`,`program_id=$2`,`idl_hash=$3`,`protocol_revision=$4`,
    `$5 IN (payload->'base'->>'asset_mint',payload->'quote'->>'asset_mint')`,
    `time<=$6::timestamptz`,`time>=$6::timestamptz-($7::int*interval '1 second')`];
  if (options.market) { values.push(new PublicKey(options.market).toBase58()); where.push(`market=$${values.length}`); }
  const filter = where.join(' AND ');
  const total = await client.query<{ total: string }>(`SELECT count(*)::text AS total FROM dusk_ingestion.streamed_market_snapshots WHERE ${filter}`,values);
  const rows = await client.query<{ observation_id: string; event_key: string; slot: string; time: Date; payload: unknown; payload_hash: string }>(
    `SELECT observation_id::text,event_key,slot::text,time,payload,payload_hash FROM dusk_ingestion.streamed_market_snapshots WHERE ${filter}
     ORDER BY time DESC,slot DESC,observation_id DESC LIMIT $${values.length+1} OFFSET $${values.length+2}`,[...values,options.limit,options.offset]);
  const references = activePriceReferences();
  const observations = rows.rows.flatMap((row) => {
    const market = String((row.payload as Record<string,unknown>).market);
    const projected = projectObservedPrices({ pin,observation: row.payload,blockTime: row.time.toISOString(),references });
    return projected.prices.filter((price) => price.mint === mint).map((price) => ({
      id: row.observation_id,mint,decimals: price.decimals,priceUsd: price.priceUsd,quality: price.quality,
      source: `dusk-observed.v1:${market}:${projected.referenceHash}:${row.slot}`,
      sourceTime: row.time.toISOString(),observedAt: row.time.toISOString(),
      evidence: { eventKey: row.event_key,market,sourceSlot: row.slot,payloadHash: row.payload_hash,referenceHash: projected.referenceHash,
        reference: price.reference,spotPriceNad: price.spotPriceNad,rounding: 'down-36-decimals',basis: 'market-observed.v1' },
      provenance: { cluster: active[0],programId: active[1],idlSha256: active[2],protocolRevision: active[3],commitment: 'confirmed' as const } }));
  });
  return { observations,
    pagination: { limit: options.limit,offset: options.offset,total: Number(total.rows[0].total) },
    coverage: { asOf: new Date(options.at).toISOString(),maxAgeSeconds: options.maxAgeSeconds,historyComplete: false,
      available: observations.length>0,basis: 'configured-and-program-derived-references.v1',historicalBackfillAvailable: false } };
}

export async function listObservedPriceHistory(options: PriceHistoryQuery) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const result = await readObservedPriceHistory(client,options);
    await client.query('COMMIT');
    return result;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

/** Provider quotes are fetched when events land, as the v1 volume enricher
 * prices each swap, and at most this often per mint. */
export const EXTERNAL_PRICE_REFRESH_MS = 30_000;

/** Refresh provider USD quotes for every referenced asset mint of a created
 * market, skipping mints refreshed within the interval. */
export async function refreshExternalPrices(): Promise<number> {
  const pin = loadPinnedProtocol(),active = identity(pin),references = activePriceReferences();
  const markets = await pool.query<{ base_mint: string; quote_mint: string; base_decimals: number; quote_decimals: number }>(`
    SELECT base_mint,quote_mint,base_decimals,quote_decimals FROM dusk_ingestion.streamed_markets
    WHERE cluster=$1 AND program_id=$2 AND idl_hash=$3 AND protocol_revision=$4 AND base_decimals IS NOT NULL AND quote_decimals IS NOT NULL`,active);
  const assets = new Map<string,number>();
  for (const row of markets.rows) { assets.set(row.base_mint,row.base_decimals); assets.set(row.quote_mint,row.quote_decimals); }
  const targets = externalPriceTargets(pin.cluster,references,[...assets].map(([mint,decimals]) => ({ mint,decimals })));
  if (!targets.length) return 0;
  const recent = await pool.query<{ mint: string }>(`SELECT DISTINCT mint FROM dusk_ingestion.price_observations
    WHERE cluster=$1 AND program_id=$2 AND idl_hash=$3 AND protocol_revision=$4 AND quality='external-observation'
      AND observed_at>now()-($5::int*interval '1 millisecond')`,[...active,EXTERNAL_PRICE_REFRESH_MS]);
  const fresh = new Set(recent.rows.map((row) => row.mint)),due = targets.filter((target) => !fresh.has(target.mint));
  if (!due.length) return 0;
  const [envelope,prices] = await Promise.all([deploymentEnvelope(),fetchExternalPrices(due)]);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await storeCaptureDeployment(client,envelope);
    await storeExternalPrices(client,prices,envelope.deploymentIdentitySha256);
    await client.query('COMMIT');
    return prices.length;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
