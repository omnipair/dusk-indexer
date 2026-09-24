import { PublicKey } from '@solana/web3.js';
import { PoolClient } from 'pg';
import pool from '../config/database';
import { canonicalJson, DuskPinnedProtocol, loadPinnedProtocol, sha256 } from '../config/duskProtocol';
import { StoredPriceCapture, verifyStoredPriceCapture } from './duskPrices';
import { QuoteCache } from './duskQuoteCache';
import { HistoryDeploymentQuery, historyDeploymentIdentities } from './duskHistoryDeployment';

export interface QuoteHistoryQuery extends HistoryDeploymentQuery {
  market: string;
  side: 'base' | 'quote';
  since: string;
  until: string;
  resolutionSeconds: number;
}
const RESOLUTIONS = [60,300,900,3600,14400,86400];
const invalid = (): never => { throw Object.assign(new Error('Invalid native quote-history selection'),{ status: 400 }); };
export function quoteHistorySelection(query: QuoteHistoryQuery) {
  const since = Date.parse(query.since),until = Date.parse(query.until);
  if (!Number.isFinite(since) || !Number.isFinite(until) || since<0 || since>=until || until>Date.now()
    || !RESOLUTIONS.includes(query.resolutionSeconds) || !['base','quote'].includes(query.side)
    || !/^[0-9a-f]{64}$/.test(query.deploymentIdentitySha256)
    || Math.ceil(until/1000/query.resolutionSeconds)-Math.floor(since/1000/query.resolutionSeconds)>2000) invalid();
  try { if (new PublicKey(query.market).toBase58() !== query.market) invalid(); } catch { invalid(); }
  return { market: query.market,side: query.side,since: new Date(since).toISOString(),until: new Date(until).toISOString(),
    resolutionSeconds: query.resolutionSeconds };
}
export function nadPrice(value: string): string {
  if (!/^(0|[1-9]\d{0,19})$/.test(value) || BigInt(value)>(1n<<64n)-1n || BigInt(value)===0n)
    throw new Error('Invalid positive program quote');
  const n = BigInt(value);
  return `${n/1_000_000_000n}.${(n%1_000_000_000n).toString().padStart(9,'0')}`.replace(/0+$/,'').replace(/\.$/,'');
}
type QuoteProjection = {
  base_mint: string; quote_mint: string; base_decimals: number; quote_decimals: number;
  base_spot_price_nad: string; quote_spot_price_nad: string;
};
type Bucket = {
  time: string; samples: string; first_slot: string; last_slot: string;
  open_id: string; close_id: string; high_id: string; low_id: string;
};

const protocolIdentity = (pin = loadPinnedProtocol()) => {
  return [pin.cluster,pin.dusk.programId,pin.dusk.idlCanonicalSha256,pin.revision];
};
export async function quoteHistoryState(client: PoolClient,market: string,pin = loadPinnedProtocol()) {
  const state = await client.query<{ revision: string; conflicted: boolean }>(
    `SELECT COALESCE((SELECT max(revision) FROM dusk_ingestion.quote_history_changes
       WHERE cluster=$1 AND program_id=$2 AND idl_hash=$3 AND protocol_revision=$4 AND market=$5),0)::text AS revision,
       conflicted FROM dusk_ingestion.quote_history_state
     WHERE cluster=$1 AND program_id=$2 AND idl_hash=$3 AND protocol_revision=$4`,[...protocolIdentity(pin),market]);
  if (state.rows[0]?.conflicted) throw Object.assign(new Error('FINALIZED_INVARIANT: contradictory finalized market price previews'),{ status:503 });
  return state.rows[0]?.revision ?? '0';
}
const verifiedSources = new QuoteCache<ReturnType<typeof verifyStoredPriceCapture>>(4096,10*60_000);
// Key all stored bytes and metadata, not merely the claimed content hash.
// A forged materialized projection must still match the verified decoded quote.
async function verifyWitness(row: StoredPriceCapture) {
  const key = sha256(canonicalJson({ ...row,block_time:row.block_time.toISOString(),
    observed_at:row.observed_at.toISOString(),raw_market:row.raw_market.toString('base64'),raw_preview:row.raw_preview.toString('base64') }));
  return verifiedSources.get(key,async () => verifyStoredPriceCapture(row));
}

/** Sampled program spot quotes, not trades. Never fill gaps or infer prices from reserves. */
export async function readQuoteHistory(client: PoolClient, query: QuoteHistoryQuery, context?: { revision: string; deployments: string[]; archive?: {pin: DuskPinnedProtocol; lastSlot: number; verify: typeof verifyStoredPriceCapture} }) {
  const window = quoteHistorySelection(query),pin = context?.archive?.pin ?? loadPinnedProtocol();
  const identity = [pin.cluster,pin.dusk.programId,pin.dusk.idlCanonicalSha256,pin.revision];
  const revision = context?.revision ?? await quoteHistoryState(client,query.market);
  const deployments = context?.deployments ?? await historyDeploymentIdentities(client,query);
  const values = [...identity,deployments,query.market,window.since,window.until,pin.historyFirstSlot,query.resolutionSeconds,context?.archive?.lastSlot ?? Number.MAX_SAFE_INTEGER];
  const column = query.side === 'base' ? 'base_spot_price_nad' : 'quote_spot_price_nad';
  // One bounded scan of the compact hypertable serves coverage, deduplication
  // and OHLC selection. Binary evidence is fetched only for the chosen witnesses.
  const selection = await client.query(`WITH selected AS MATERIALIZED (
    SELECT *,time AS block_time,${column} AS price FROM dusk_ingestion.quote_series
    WHERE cluster=$1 AND program_id=$2 AND idl_hash=$3 AND protocol_revision=$4
      AND deployment_identity_sha256=ANY($5::text[]) AND market=$6
      AND time>=$7::timestamptz AND time<$8::timestamptz AND slot>=$9 AND slot<=$11
  ), coverage AS (
    SELECT count(*)::text AS captures,count(base_mint)::text AS projected,
      min(slot)::text AS first_slot,max(slot)::text AS last_slot,
      min(block_time) AS first_time,max(block_time) AS last_time,
      COALESCE(max(capture_id),0)::text AS watermark,
      count(DISTINCT(base_mint,quote_mint,base_decimals,quote_decimals)) FILTER(WHERE base_mint IS NOT NULL)::int AS bindings
    FROM selected
  ), samples AS MATERIALIZED (
    SELECT DISTINCT ON(slot) capture_id,slot,block_time,price FROM selected
    WHERE base_mint IS NOT NULL ORDER BY slot,capture_id
  ), counts AS (
    SELECT count(*)::text AS samples,count(*) FILTER(WHERE price=0)::text AS unavailable FROM samples
  ), buckets AS (
    SELECT extract(epoch FROM dusk_ingestion.quote_bucket(block_time,$10::int))::bigint AS time,
      count(*)::text AS samples,min(slot)::text AS first_slot,max(slot)::text AS last_slot,
      (array_agg(capture_id ORDER BY block_time,slot))[1]::text AS open_id,
      (array_agg(capture_id ORDER BY block_time DESC,slot DESC))[1]::text AS close_id,
      (array_agg(capture_id ORDER BY price DESC,block_time,slot))[1]::text AS high_id,
      (array_agg(capture_id ORDER BY price,block_time,slot))[1]::text AS low_id
    FROM samples WHERE price>0 GROUP BY 1
  ) SELECT row_to_json(coverage) AS coverage,row_to_json(counts) AS counts,
      COALESCE((SELECT json_agg(buckets ORDER BY time) FROM buckets),'[]'::json) AS buckets
    FROM coverage CROSS JOIN counts`,values);
  const { coverage,counts } = selection.rows[0];
  const buckets: { rows: Bucket[] } = { rows: selection.rows[0].buckets };
  if (coverage.bindings>1) throw new Error('FINALIZED_INVARIANT: market quote bindings changed');
  // Return prices rebuilt from saved, hashed Borsh bytes. SQL selects the four
  // witnesses for each bar; the response never trusts a selected materialized
  // price without checking its source and market bindings.
  const ids = [...new Set(buckets.rows.flatMap(row => [row.open_id,row.close_id,row.high_id,row.low_id]))];
  const witnesses = ids.length ? await client.query<StoredPriceCapture & QuoteProjection>(`SELECT o.*,o.capture_id::text,o.slot::text,o.market_slot::text,
      q.base_mint,q.quote_mint,q.base_decimals,q.quote_decimals,q.base_spot_price_nad::text,q.quote_spot_price_nad::text
    FROM dusk_ingestion.price_capture_observations o JOIN dusk_ingestion.market_quote_projections q USING(capture_id)
    WHERE o.capture_id=ANY($1::bigint[])`,[ids]) : { rows: [] };
  const verified = new Map<string,{ nad: string; oracle: string; sourceHash: string; time: string; sourceSlot: string }>();
  let binding: { baseMint: string; quoteMint: string; baseDecimals: number; quoteDecimals: number } | null = null;
  for (const row of witnesses.rows) {
    const { source,projected,oraclePrices } = context?.archive ? context.archive.verify(row) : await verifyWitness(row),bound = projected.bound;
    if (source.market !== query.market || !deployments.includes(source.deploymentIdentitySha256)
      || source.slot<pin.historyFirstSlot || source.slot>(context?.archive?.lastSlot ?? Number.MAX_SAFE_INTEGER) || source.blockTime<window.since || source.blockTime>=window.until
      || row.base_mint !== bound.baseMint || row.quote_mint !== bound.quoteMint
      || row.base_decimals !== bound.baseDecimals || row.quote_decimals !== bound.quoteDecimals
      || row.base_spot_price_nad !== projected.spotPrices.base || row.quote_spot_price_nad !== projected.spotPrices.quote
      || binding && canonicalJson(binding) !== canonicalJson(bound))
      throw new Error('FINALIZED_INVARIANT: quote-history projection differs from its source');
    binding = bound;
    verified.set(row.capture_id,{ nad: projected.spotPrices[query.side],oracle: oraclePrices[query.side],sourceHash: row.content_hash,
      time: source.blockTime,sourceSlot: String(source.slot) });
  }
  const witness = (id: string, oracle = false) => {
    const value = verified.get(id);
    if (!value) throw new Error('FINALIZED_INVARIANT: quote-history source disappeared');
    return { captureId: id,sourceHash: value.sourceHash,price: nadPrice(oracle ? value.oracle : value.nad),time: value.time,sourceSlot: value.sourceSlot };
  };
  const candles = buckets.rows.map(row => ({ time: Number(row.time),samples: row.samples,
    firstSourceSlot: row.first_slot,lastSourceSlot: row.last_slot,
    open: witness(row.open_id),high: witness(row.high_id),low: witness(row.low_id),close: witness(row.close_id),
    oracleClose: verified.get(row.close_id)?.oracle !== '0' ? witness(row.close_id, true) : null }));
  const pending = (BigInt(coverage.captures)-BigInt(coverage.projected)).toString();
  const data = {
    schemaVersion: 'dusk-quote-history.v1',window,binding,candles,revision,
    coverage: { cluster: pin.cluster,programId: pin.dusk.programId,idlSha256: pin.dusk.idlCanonicalSha256,
      protocolRevision: pin.revision,deploymentIdentitySha256: query.deploymentIdentitySha256,commitment: 'finalized',
      basis: 'sampled-program-spot-quotes.v1',priceScale: 'decimal-normalized-nad',historyRangeComplete: false,
      tradeOhlcAvailable: false,gapsFilled: false,projectionComplete: pending==='0',
      captures: coverage.captures,projectedCaptures: coverage.projected,pendingCaptures: pending,
      samples: counts.samples,unavailableSamples: counts.unavailable,watermark: coverage.watermark,
      firstSourceSlot: coverage.first_slot,lastSourceSlot: coverage.last_slot,
      firstCaptureAt: coverage.first_time ? new Date(coverage.first_time).toISOString() : null,lastCaptureAt: coverage.last_time ? new Date(coverage.last_time).toISOString() : null },
  };
  return { ...data,selectionHash: sha256(canonicalJson(data)) };
}

type QuoteHistory = Awaited<ReturnType<typeof readQuoteHistory>>;
const historyCache = new QuoteCache<QuoteHistory>(32,15_000);
export function clearQuoteHistoryCache() { historyCache.clear(); verifiedSources.clear(); }

export interface QuoteHistoryRefresh { afterRevision: string; afterUntil: string }
export async function readQuoteHistoryRequest(client: PoolClient,query: QuoteHistoryQuery,refresh?: QuoteHistoryRefresh,useCache=false) {
  const requested = quoteHistorySelection(query);
  if (refresh && (!/^(0|[1-9]\d{0,18})$/.test(refresh.afterRevision)
    || !Number.isFinite(Date.parse(refresh.afterUntil)) || Date.parse(refresh.afterUntil)<=Date.parse(requested.since)
    || Date.parse(refresh.afterUntil)>Date.parse(requested.until))) invalid();
  {
    const revision = await quoteHistoryState(client,query.market);
    const deployments = await historyDeploymentIdentities(client,query);
    let since = requested.since;
    if (refresh) {
      if (BigInt(refresh.afterRevision)>BigInt(revision)) throw Object.assign(new Error('Quote history revision regressed'),{ status:409 });
      const changes = await client.query<{ earliest: Date | null }>(`
        SELECT min(minute) AS earliest FROM dusk_ingestion.quote_history_changes
        WHERE cluster=$1 AND program_id=$2 AND idl_hash=$3 AND protocol_revision=$4
          AND market=$5 AND revision>$6 AND minute<$8::timestamptz
          AND minute+interval '1 minute'>$7::timestamptz`,
        [...protocolIdentity(),query.market,refresh.afterRevision,requested.since,requested.until]);
      // Always include the previously partial last bucket. This covers samples
      // already ingested beyond the previous exclusive `until`, even with no
      // revision change. Late backfills widen this suffix to their oldest bucket.
      const earliest = Math.min(Date.parse(refresh.afterUntil)-1,changes.rows[0].earliest?.getTime() ?? Infinity);
      since = new Date(Math.max(Date.parse(requested.since),
        Math.floor(earliest/1000/query.resolutionSeconds)*query.resolutionSeconds*1000)).toISOString();
    }
    const selection = { ...query,since };
    const key = canonicalJson([query.deploymentIdentitySha256,deployments.slice().sort(),revision,quoteHistorySelection(selection)]);
    const load = () => readQuoteHistory(client,selection,{ revision,deployments });
    const data = useCache ? await historyCache.get(key,load) : await load();
    return refresh ? { schemaVersion:'dusk-quote-history-update.v1',request:requested,
      afterRevision:refresh.afterRevision,afterUntil:new Date(refresh.afterUntil).toISOString(),revision,history:data } : data;
  }
}

export async function listQuoteHistory(query: QuoteHistoryQuery,refresh?: QuoteHistoryRefresh) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const data = await readQuoteHistoryRequest(client,query,refresh,true);
    await client.query('COMMIT');
    return data;
  } catch (error) { clearQuoteHistoryCache(); await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
