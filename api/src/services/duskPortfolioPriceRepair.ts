import { PoolClient } from 'pg';
import pool from '../config/database';
import { canonicalJson, sha256 } from '../config/duskProtocol';
import { fetchBirdeyeHistoricalPriceRange } from './birdeyePriceService';
import { HistoricalPoint, historicalIdentity, historicalPriceAt, HISTORICAL_PRICE_MATURITY_MS,
  HISTORICAL_PRICE_WINDOW_MS, normalizeHistoricalPoints, PORTFOLIO_REPAIR_POLICY,
  reconstructPortfolioPrices, validateHistoricalPoint } from './duskHistoricalPriceMath';
import { verifyStoredPortfolioCapture } from './duskPortfolioSnapshots';
import { positiveDecimal } from './duskPriceMath';

export const PORTFOLIO_PRICE_REPAIR_INTERVAL_MS = 5*60*1000;
export interface PortfolioPriceRepairOptions {
  now?: () => Date; dryRun?: boolean; limit?: number; maxRequests?: number;
  fetchPrices?: typeof fetchBirdeyeHistoricalPriceRange;
}
export interface PortfolioPriceRepairResult {
  examinedCaptures: number; repairedCheckpoints: number; unresolvedCheckpoints: number;
  providerRequests: number; providerFailures: number; cachedPoints: number; dryRun: boolean; busy: boolean;
}
function result(dryRun: boolean): PortfolioPriceRepairResult {
  return { examinedCaptures: 0,repairedCheckpoints: 0,unresolvedCheckpoints: 0,
    providerRequests: 0,providerFailures: 0,cachedPoints: 0,dryRun,busy: false };
}
async function readPoints(client: PoolClient,mints: string[],from: Date,until: Date): Promise<HistoricalPoint[]> {
  const rows = await client.query(`SELECT point_id::text,mint,source_time,fetched_at,price_usd::text,evidence,content_hash
    FROM dusk_ingestion.historical_price_points WHERE cluster=$1 AND program_id=$2 AND idl_hash=$3 AND protocol_revision=$4
      AND mint=ANY($5::text[]) AND source_time BETWEEN $6 AND $7 ORDER BY mint,source_time`,[...historicalIdentity(),mints,from,until]);
  return rows.rows.map(row => {
    if (positiveDecimal(row.price_usd) !== row.evidence.priceUsd) throw new Error('FINALIZED_INVARIANT: cached historical price differs from its evidence');
    return validateHistoricalPoint({ pointId: row.point_id,mint: row.mint,sourceTime: row.source_time.toISOString(),
      fetchedAt: row.fetched_at.toISOString(),priceUsd: row.evidence.priceUsd,evidence: row.evidence,contentHash: row.content_hash });
  });
}
async function savePoints(client: PoolClient,points: HistoricalPoint[]) {
  if (!points.length) return;
  await client.query(`INSERT INTO dusk_ingestion.historical_price_points
    (cluster,program_id,idl_hash,protocol_revision,provider,mint,resolution,source_time,fetched_at,price_usd,evidence,content_hash)
    SELECT $1,$2,$3,$4,'birdeye',p->>'mint','1m',(p->>'sourceTime')::timestamptz,(p->>'fetchedAt')::timestamptz,
      (p->>'priceUsd')::numeric,p->'evidence',p->>'contentHash' FROM jsonb_array_elements($5::jsonb) p
    ON CONFLICT(cluster,program_id,idl_hash,protocol_revision,provider,mint,resolution,source_time) DO NOTHING`,
    [...historicalIdentity(),JSON.stringify(points)]);
}

/** The caller owns one connection/session lock. Each INSERT is atomic; HTTP
 * requests never hold a transaction open. A crash can leave cached prices but
 * cannot replace a capture or publish a half-repaired owner checkpoint. */
export async function repairPortfolioPriceBatch(client: PoolClient,options: PortfolioPriceRepairOptions = {}) {
  const now = options.now ?? (() => new Date()),started = now(),limit = options.limit ?? 100,maxRequests = options.maxRequests ?? 4;
  const stats = result(Boolean(options.dryRun));
  if (!Number.isFinite(started.getTime()) || !Number.isSafeInteger(limit) || limit<1 || limit>500
    || !Number.isSafeInteger(maxRequests) || maxRequests<0 || maxRequests>8) throw new Error('Invalid bounded portfolio repair options');
  if (historicalIdentity()[0] !== 'mainnet-beta') throw new Error('Historical price repair requires the mainnet protocol pin');
  const candidates = await client.query(`SELECT o.* FROM dusk_ingestion.portfolio_capture_observations o
    LEFT JOIN dusk_ingestion.portfolio_price_repair_attempts a USING(capture_id)
    WHERE o.cluster=$1 AND o.program_id=$2 AND o.idl_hash=$3 AND o.protocol_revision=$4
      AND o.capture_time<=$5::timestamptz-interval '2 minutes' AND (a.retry_after IS NULL OR a.retry_after<=$5)
      AND EXISTS(SELECT 1 FROM dusk_ingestion.portfolio_checkpoints c WHERE c.capture_id=o.capture_id
        AND (c.valuations->>'unvaluedComponents')::int>0
        AND NOT EXISTS(SELECT 1 FROM dusk_ingestion.portfolio_price_repairs r WHERE r.capture_id=c.capture_id AND r.owner=c.owner))
    ORDER BY o.capture_time,o.capture_id LIMIT $6`,[...historicalIdentity(),started,limit]);
  const rows = candidates.rows.filter(row => row.capture_time.getTime()-candidates.rows[0].capture_time.getTime()<HISTORICAL_PRICE_WINDOW_MS);
  if (!rows.length) return stats;
  const needs = new Map<string,Set<string>>(),projected = new Map<string,ReturnType<typeof verifyStoredPortfolioCapture>>();
  for (const row of rows) {
    const original = verifyStoredPortfolioCapture(row); projected.set(String(row.capture_id),original);
    for (const owner of original.owners) for (const component of owner.components) {
      if (!component.issues.includes('missing-price-reference') || component.issues.includes('market-preview-unavailable')) continue;
      for (const mint of component.valuation.missingMints) {
        const times = needs.get(mint) ?? new Set<string>(); times.add(component.sourceTime); needs.set(mint,times);
      }
    }
  }
  const times = [...needs.values()].flatMap(value => [...value]).map(Date.parse);
  const from = new Date(Math.floor(Math.min(...times)/60_000)*60_000);
  const until = new Date(Math.min(from.getTime()+HISTORICAL_PRICE_WINDOW_MS,
    Math.floor(Math.min(Math.max(...times),started.getTime()-HISTORICAL_PRICE_MATURITY_MS)/60_000)*60_000));
  let points: HistoricalPoint[] = [];
  if (times.length) {
    points = await readPoints(client,[...needs.keys()],from,until);
    for (const [mint,required] of [...needs].sort(([a],[b]) => a.localeCompare(b))) {
      const within = [...required].filter(at => Date.parse(at)>=from.getTime() && Date.parse(at)<until.getTime()+60_000);
      if (!within.length || within.every(at => historicalPriceAt(points,mint,at)) || stats.providerRequests>=maxRequests) continue;
      stats.providerRequests++;
      let normalized: HistoricalPoint[];
      try {
        const fetched = await (options.fetchPrices ?? fetchBirdeyeHistoricalPriceRange)(mint,from,until,{ resolution: '1m',timeoutMs: 5000 });
        if (!fetched) { stats.providerFailures++; continue; }
        normalized = normalizeHistoricalPoints(mint,from,until,now(),fetched);
      } catch { stats.providerFailures++; continue; }
      // Database failures are outside the provider catch: never disguise them
      // as a missing quote and commit retry state over a failed persistence.
      if (stats.dryRun) points.push(...normalized);
      else { await savePoints(client,normalized); stats.cachedPoints += normalized.length; }
    }
    if (!stats.dryRun) points = await readPoints(client,[...needs.keys()],from,until);
  }
  for (const row of rows) {
    const captureId = String(row.capture_id),original = projected.get(captureId)!;
    const checkpoints = await client.query(`SELECT * FROM dusk_ingestion.portfolio_checkpoints
      WHERE capture_id=$1 AND (valuations->>'unvaluedComponents')::int>0
        AND NOT EXISTS(SELECT 1 FROM dusk_ingestion.portfolio_price_repairs r WHERE r.capture_id=$1 AND r.owner=portfolio_checkpoints.owner)`,[captureId]);
    const rebuilt = reconstructPortfolioPrices(row.source,points);
    let unresolved = false;
    for (const checkpoint of checkpoints.rows) {
      const before = original.owners.find(owner => owner.owner === checkpoint.owner),after = rebuilt.find(owner => owner.owner === checkpoint.owner);
      if (!before || !after || canonicalJson(before.components) !== canonicalJson(checkpoint.components)
        || canonicalJson(before.valuations) !== canonicalJson(checkpoint.valuations)
        || checkpoint.coverage.sourceHash !== row.content_hash)
        throw new Error('FINALIZED_INVARIANT: original portfolio projection differs from saved evidence');
      if (after.valuations.unvaluedComponents || !after.priceEvidence.length) { unresolved = true; stats.unresolvedCheckpoints++; continue; }
      const repairedAt = now().toISOString();
      const contentHash = sha256(canonicalJson([historicalIdentity(),captureId,checkpoint.owner,PORTFOLIO_REPAIR_POLICY,row.content_hash,
        after.components,after.valuations,after.priceEvidence]));
      if (!stats.dryRun) {
        const inserted = await client.query(`INSERT INTO dusk_ingestion.portfolio_price_repairs
          (capture_id,owner,policy,source_hash,repaired_at,components,valuations,price_evidence,content_hash)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(capture_id,owner) DO NOTHING RETURNING repair_id`,
          [captureId,checkpoint.owner,PORTFOLIO_REPAIR_POLICY,row.content_hash,repairedAt,
            JSON.stringify(after.components),JSON.stringify(after.valuations),JSON.stringify(after.priceEvidence),contentHash]);
        stats.repairedCheckpoints += inserted.rowCount ?? 0;
      } else stats.repairedCheckpoints++;
    }
    if (!stats.dryRun) await client.query(`INSERT INTO dusk_ingestion.portfolio_price_repair_attempts(capture_id,attempts,retry_after,last_status)
      VALUES($1,1,$2::timestamptz+interval '5 minutes',$3)
      ON CONFLICT(capture_id) DO UPDATE SET attempts=portfolio_price_repair_attempts.attempts+1,
        retry_after=$2::timestamptz+least(21600,300*power(2,least(portfolio_price_repair_attempts.attempts,7))) * interval '1 second',
        last_status=EXCLUDED.last_status`,[captureId,now(),unresolved ? 'unavailable' : 'repaired']);
    stats.examinedCaptures++;
  }
  return stats;
}

export async function repairPortfolioPriceHistory(options: PortfolioPriceRepairOptions = {}) {
  const client = await pool.connect(),lock = `dusk:portfolio-price-repair:${JSON.stringify(historicalIdentity())}`;
  let held = false,destroy = false;
  try {
    held = (await client.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS held',[lock])).rows[0].held;
    if (!held) return { ...result(Boolean(options.dryRun)),busy: true };
    return await repairPortfolioPriceBatch(client,options);
  } finally {
    if (held) try { await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[lock]); } catch { destroy = true; }
    client.release(destroy);
  }
}
