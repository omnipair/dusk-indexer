import { PoolClient } from 'pg';
import { PublicKey } from '@solana/web3.js';
import pool from '../config/database';
import { loadPinnedProtocol, sha256, canonicalJson } from '../config/duskProtocol';
import { HistoryDeploymentQuery } from './duskHistoryDeployment';
import { activePriceReferences, projectObservedPrices } from './duskPriceMath';
import { MarketGrowthPoint, observedGrowthPoint, recordedYlpRates, YieldRatePrice } from './duskYieldRateMath';

export interface YieldRatesQuery extends HistoryDeploymentQuery { since: string; until: string; market?: string }
interface Observation { market: string; slot: string; time: Date; payload: unknown; payload_hash: string }
type ActiveProtocol = [string,string,string,string];

function activeProtocol(pin: ReturnType<typeof loadPinnedProtocol>): ActiveProtocol {
  return [pin.cluster,pin.dusk.programId,pin.dusk.idlCanonicalSha256,pin.revision];
}

/** A committed snapshot remains the market's state until the next swap, so the
 * latest one at or before a growth point prices it. */
async function observedPricesAt(client: PoolClient,pin: ReturnType<typeof loadPinnedProtocol>,
  references: ReturnType<typeof activePriceReferences>,deploymentIdentitySha256: string,point: MarketGrowthPoint) {
  const rows = await client.query<Observation>(`SELECT market,slot::text,time,payload,payload_hash
    FROM dusk_ingestion.streamed_market_snapshots
    WHERE cluster=$1 AND program_id=$2 AND idl_hash=$3 AND protocol_revision=$4
      AND market=$5 AND slot<=$6 AND time<=$7
    ORDER BY slot DESC,observation_id DESC LIMIT 1`,[...activeProtocol(pin),point.market,point.slot,point.blockTime]);
  const row = rows.rows[0];
  if (!row) return { prices: [],provenance: null };
  const projected = projectObservedPrices({ pin,observation: row.payload,blockTime: row.time.toISOString(),references });
  return { prices: projected.prices,provenance: { sourceSlot: row.slot,blockTime: row.time.toISOString(),
    deploymentIdentitySha256,contentHash: row.payload_hash,referenceHash: projected.referenceHash } };
}

/** Recorded claimable yLP earnings only. Compounding, unpaid debt interest and
 * protocol revenue remain separate; these rates are never a full APY. Growth
 * points and their prices come from post-swap market snapshots. */
export async function readYieldRates(client: PoolClient,options: YieldRatesQuery) {
  const pin = loadPinnedProtocol(),active = activeProtocol(pin);
  const since = Date.parse(options.since),until = Date.parse(options.until);
  if (!/^[0-9a-f]{64}$/.test(options.deploymentIdentitySha256) || !Number.isFinite(since) || !Number.isFinite(until)
    || until-since<3600_000 || until-since>90*86400_000 || until>Date.now()
    || options.market !== undefined && new PublicKey(options.market).toBase58() !== options.market)
    throw Object.assign(new Error('Invalid recorded yield window'),{ status: 400 });
  const sources = await client.query<Observation & { boundary: 'start' | 'end' }>(`
    WITH markets AS (
      SELECT DISTINCT market FROM dusk_ingestion.streamed_market_snapshots
      WHERE cluster=$1 AND program_id=$2 AND idl_hash=$3 AND protocol_revision=$4 AND ($7::text IS NULL OR market=$7)
    ), boundaries(boundary,at) AS (VALUES ('start',$5::timestamptz),('end',$6::timestamptz))
    SELECT m.market,o.slot::text,o.time,o.payload,o.payload_hash,b.boundary
    FROM markets m CROSS JOIN boundaries b
    JOIN LATERAL (
      SELECT slot,time,payload,payload_hash,observation_id FROM dusk_ingestion.streamed_market_snapshots
      WHERE cluster=$1 AND program_id=$2 AND idl_hash=$3 AND protocol_revision=$4
        AND market=m.market AND time<=b.at
      ORDER BY slot DESC,observation_id DESC LIMIT 1
    ) o ON true ORDER BY m.market,b.boundary`,
    [...active,new Date(since).toISOString(),new Date(until).toISOString(),options.market ?? null]);
  const byMarket = new Map<string,Partial<Record<'start'|'end',{ point: MarketGrowthPoint; contentHash: string }>>>();
  for (const row of sources.rows) {
    const point = observedGrowthPoint({ pin,marketAddress: row.market,observation: row.payload,slot: Number(row.slot),
      blockTime: row.time.toISOString(),deploymentIdentitySha256: options.deploymentIdentitySha256 });
    const market = byMarket.get(point.market) ?? {};
    if (market[row.boundary]) throw new Error('FINALIZED_INVARIANT: duplicate yield growth boundary');
    market[row.boundary] = { point,contentHash: row.payload_hash };
    byMarket.set(point.market,market);
  }
  const references = activePriceReferences();
  const priceAt = (point: MarketGrowthPoint) =>
    observedPricesAt(client,pin,references,options.deploymentIdentitySha256,point);
  const markets = [];
  for (const [market,{start,end}] of byMarket) {
    if (!start || !end || start.point.slot>=end.point.slot) continue; // Missing brackets remain explicitly unmeasured.
    const initialPrice = await priceAt(start.point),finalPrice = await priceAt(end.point);
    const rates = recordedYlpRates({start:start.point,end:end.point,startPrices:initialPrice.prices,endPrices:finalPrice.prices});
    markets.push({ market,lpMint: start.point.lpMint,rates,
      window: { since: start.point.blockTime,until: end.point.blockTime },
      provenance: { startSlot: String(start.point.slot),endSlot: String(end.point.slot),
        startContentHash: start.contentHash,endContentHash: end.contentHash,
        startDeploymentIdentitySha256: start.point.deploymentIdentitySha256,endDeploymentIdentitySha256: end.point.deploymentIdentitySha256,
        initialPrice: initialPrice.provenance,finalPrice: finalPrice.provenance } });
  }
  const window = { since: new Date(since).toISOString(),until: new Date(until).toISOString(),
    maxSnapshotAgeSeconds: null,maxPriceAgeSeconds: null };
  return { schemaVersion: 'dusk-yield-rates.v1' as const,window,markets,
    coverage: { cluster: pin.cluster,programId: pin.dusk.programId,idlSha256: pin.dusk.idlCanonicalSha256,
      protocolRevision: pin.revision,deploymentIdentitySha256: options.deploymentIdentitySha256,commitment: 'confirmed' as const,
      basis: 'committed-market-growth.v1' as const,fullApyAvailable: false as const,
      sourceSlot: Math.max(0,...sources.rows.map(row => Number(row.slot))),
      selectionHash: sha256(canonicalJson([active,options.deploymentIdentitySha256,window,markets])) } };
}

export interface TrailingYlpRate {
  market: string;
  swapRatePct: string | null;
  interestRatePct: string | null;
  /** `none` when no swap committed growth inside the window. */
  growth: 'recorded' | 'none';
}

/** A market's identity as its live account states it. */
export interface TrailingYlpMarket {
  market: string; ylpMint: string;
  baseMint: string; quoteMint: string; baseDecimals: number; quoteDecimals: number;
}

/**
 * One market's recorded yLP rates over a trailing window, annualized over the
 * whole window the way v1 annualizes LP APR over its fixed seven days.
 *
 * Growth points are the market's streamed SwapExecuted events, bound to the
 * market's live identity rather than to a streamed MarketCreated row, so a
 * market created before the stream started is still measured from the swaps
 * the stream holds. Growth indexes only move on committed swaps: the last swap
 * before the window stands for the window's start, a market first swapped
 * inside the window starts at that swap, and a market with no swap in the
 * window has zero recorded growth.
 */
export async function readTrailingYlpRate(client: PoolClient,options: {
  deploymentIdentitySha256: string; until: number; windowMs: number; market: TrailingYlpMarket;
}): Promise<TrailingYlpRate> {
  const pin = loadPinnedProtocol(),active = activeProtocol(pin),meta = options.market;
  const until = options.until,since = until-options.windowMs;
  if (!/^[0-9a-f]{64}$/.test(options.deploymentIdentitySha256) || !Number.isSafeInteger(until)
    || !Number.isSafeInteger(options.windowMs) || options.windowMs<3600_000 || options.windowMs>90*86400_000
    || new PublicKey(meta.market).toBase58() !== meta.market)
    throw new Error('Invalid trailing yield window');
  const swap = (boundary: string,where: string,order: 'ASC' | 'DESC') => `
    SELECT '${boundary}' AS boundary,slot::text,time,payload,payload_hash FROM (
      SELECT slot,time,payload,payload_hash,observation_id FROM dusk_ingestion.streamed_events
      WHERE cluster=$1 AND program_id=$2 AND idl_hash=$3 AND protocol_revision=$4
        AND event_name='SwapExecuted' AND payload->>'market'=$5 AND payload ?& ARRAY['ylp_supply','base','quote']
        AND ${where}
      ORDER BY slot ${order},observation_id ${order} LIMIT 1) o`;
  const sources = await client.query<Omit<Observation,'market'> & { boundary: 'before' | 'first' | 'end' }>(
    `${swap('before','time<=$6','DESC')} UNION ALL ${swap('first','time>$6 AND time<=$7','ASC')}
    UNION ALL ${swap('end','time<=$7','DESC')}`,
    [...active,meta.market,new Date(since).toISOString(),new Date(until).toISOString()]);
  const references = activePriceReferences();
  const points: Partial<Record<'before' | 'first' | 'end',{ point: MarketGrowthPoint; prices: YieldRatePrice[] }>> = {};
  for (const row of sources.rows) {
    // The streamed_market_snapshots shape, with the live market's identity.
    const event = row.payload as Record<string,Record<string,unknown> | string>;
    const side = (name: 'base' | 'quote',mint: string,decimals: number) => ({
      ...(event[name] as Record<string,unknown>),asset_mint: mint,asset_decimals: String(decimals),
      live_reserve: event[`${name}_live_reserve`] });
    const observation = { market: meta.market,ylp_mint: meta.ylpMint,slot: event.slot,ylp_supply: event.ylp_supply,
      base: side('base',meta.baseMint,meta.baseDecimals),quote: side('quote',meta.quoteMint,meta.quoteDecimals) };
    const blockTime = row.time.toISOString();
    if (points[row.boundary]) throw new Error('FINALIZED_INVARIANT: duplicate yield growth boundary');
    points[row.boundary] = {
      point: observedGrowthPoint({ pin,marketAddress: meta.market,observation,slot: Number(row.slot),blockTime,
        deploymentIdentitySha256: options.deploymentIdentitySha256 }),
      prices: projectObservedPrices({ pin,observation,blockTime,references }).prices,
    };
  }
  const start = points.before ?? points.first,end = points.end;
  if (!start || !end || start.point.slot>=end.point.slot)
    return { market: meta.market,swapRatePct: '0',interestRatePct: '0',growth: 'none' };
  const recorded = recordedYlpRates({ start: start.point,end: end.point,startPrices: start.prices,endPrices: end.prices });
  // recordedYlpRates annualizes over start..end; spread that growth over the window.
  const share = (Date.parse(end.point.blockTime)-Date.parse(start.point.blockTime))/options.windowMs;
  const spread = (value: string | null) => value === null ? null : String(Number(value)*share);
  return { market: meta.market,swapRatePct: spread(recorded.swapRatePct),interestRatePct: spread(recorded.interestRatePct),
    growth: 'recorded' };
}

export async function listTrailingYlpRate(options: Parameters<typeof readTrailingYlpRate>[1]) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const result = await readTrailingYlpRate(client,options);
    await client.query('COMMIT');
    return result;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

export async function listYieldRates(options: YieldRatesQuery) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const result = await readYieldRates(client,options);
    await client.query('COMMIT');
    return result;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
