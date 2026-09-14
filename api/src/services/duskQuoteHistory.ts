import { PublicKey } from '@solana/web3.js';
import { PoolClient } from 'pg';
import pool from '../config/database';
import { canonicalJson, loadPinnedProtocol, sha256 } from '../config/duskProtocol';
import { assertNoPriceConflict, StoredPriceCapture, verifyStoredPriceCapture } from './duskPrices';

export interface QuoteHistoryQuery {
  market: string;
  side: 'base' | 'quote';
  since: string;
  until: string;
  resolutionSeconds: number;
  deploymentIdentitySha256: string;
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

/** Sampled program spot quotes, not trades. Never fill gaps or infer prices from reserves. */
export async function readQuoteHistory(client: PoolClient, query: QuoteHistoryQuery) {
  const window = quoteHistorySelection(query),pin = loadPinnedProtocol();
  const identity = [pin.cluster,pin.dusk.programId,pin.dusk.idlCanonicalSha256,pin.revision];
  await assertNoPriceConflict(client);
  const values = [...identity,query.deploymentIdentitySha256,query.market,window.since,window.until,pin.historyFirstSlot];
  const selected = `FROM dusk_ingestion.price_capture_observations o
    LEFT JOIN dusk_ingestion.market_quote_projections q USING(capture_id)
    WHERE o.cluster=$1 AND o.program_id=$2 AND o.idl_hash=$3 AND o.protocol_revision=$4
      AND o.deployment_identity_sha256=$5 AND o.market=$6 AND o.block_time>=$7::timestamptz AND o.block_time<$8::timestamptz
      AND o.slot>=$9`;
  // The selection and its coverage share the caller's repeatable-read snapshot.
  const coverageRead = await client.query(`SELECT count(*)::text AS captures,count(q.capture_id)::text AS projected,
      min(o.slot)::text AS first_slot,max(o.slot)::text AS last_slot,
      min(o.block_time) AS first_time,max(o.block_time) AS last_time,
      COALESCE(max(o.capture_id),0)::text AS watermark,
      count(DISTINCT (q.base_mint,q.quote_mint,q.base_decimals,q.quote_decimals)) FILTER(WHERE q.capture_id IS NOT NULL)::int AS bindings
    ${selected}`,values);
  const coverage = coverageRead.rows[0];
  if (coverage.bindings>1) throw new Error('FINALIZED_INVARIANT: market quote bindings changed');
  const column = query.side === 'base' ? 'base_spot_price_nad' : 'quote_spot_price_nad';
  // Changing a USD reference can produce another capture of the same bank.
  // Such a capture is one price sample, not an extra tick or a volume count.
  const samplesCte = `WITH samples AS (
    SELECT DISTINCT ON(o.slot) o.capture_id,o.slot,o.block_time,q.${column} AS price
    ${selected} AND q.capture_id IS NOT NULL ORDER BY o.slot,o.capture_id
  )`;
  const counts = await client.query(`${samplesCte} SELECT count(*)::text AS samples,
    count(*) FILTER(WHERE price=0)::text AS unavailable FROM samples`,values);
  const buckets = await client.query<Bucket>(`${samplesCte}
    SELECT (floor(extract(epoch FROM block_time)/$10::int)*$10::int)::bigint AS time,
      count(*)::text AS samples,min(slot)::text AS first_slot,max(slot)::text AS last_slot,
      (array_agg(capture_id ORDER BY block_time,slot))[1]::text AS open_id,
      (array_agg(capture_id ORDER BY block_time DESC,slot DESC))[1]::text AS close_id,
      (array_agg(capture_id ORDER BY price DESC,block_time,slot))[1]::text AS high_id,
      (array_agg(capture_id ORDER BY price,block_time,slot))[1]::text AS low_id
    FROM samples WHERE price>0 GROUP BY 1 ORDER BY 1`,[...values,query.resolutionSeconds]);
  // Return prices rebuilt from saved, hashed Borsh bytes. SQL selects the four
  // witnesses for each bar; the response never trusts a selected materialized
  // price without checking its source and market bindings.
  const ids = [...new Set(buckets.rows.flatMap(row => [row.open_id,row.close_id,row.high_id,row.low_id]))];
  const witnesses = ids.length ? await client.query<StoredPriceCapture & QuoteProjection>(`SELECT o.*,o.capture_id::text,o.slot::text,o.market_slot::text,
      q.base_mint,q.quote_mint,q.base_decimals,q.quote_decimals,q.base_spot_price_nad::text,q.quote_spot_price_nad::text
    FROM dusk_ingestion.price_capture_observations o JOIN dusk_ingestion.market_quote_projections q USING(capture_id)
    WHERE o.capture_id=ANY($1::bigint[])`,[ids]) : { rows: [] };
  const verified = new Map<string,{ nad: string; sourceHash: string }>();
  let binding: { baseMint: string; quoteMint: string; baseDecimals: number; quoteDecimals: number } | null = null;
  for (const row of witnesses.rows) {
    const { source,projected } = verifyStoredPriceCapture(row),bound = projected.bound;
    if (source.market !== query.market || source.deploymentIdentitySha256 !== query.deploymentIdentitySha256
      || source.slot<pin.historyFirstSlot || source.blockTime<window.since || source.blockTime>=window.until
      || row.base_mint !== bound.baseMint || row.quote_mint !== bound.quoteMint
      || row.base_decimals !== bound.baseDecimals || row.quote_decimals !== bound.quoteDecimals
      || row.base_spot_price_nad !== projected.spotPrices.base || row.quote_spot_price_nad !== projected.spotPrices.quote
      || binding && canonicalJson(binding) !== canonicalJson(bound))
      throw new Error('FINALIZED_INVARIANT: quote-history projection differs from its source');
    binding = bound;
    verified.set(row.capture_id,{ nad: projected.spotPrices[query.side],sourceHash: row.content_hash });
  }
  const witness = (id: string) => {
    const value = verified.get(id);
    if (!value) throw new Error('FINALIZED_INVARIANT: quote-history source disappeared');
    return { captureId: id,sourceHash: value.sourceHash,price: nadPrice(value.nad) };
  };
  const candles = buckets.rows.map(row => ({ time: Number(row.time),samples: row.samples,
    firstSourceSlot: row.first_slot,lastSourceSlot: row.last_slot,
    open: witness(row.open_id),high: witness(row.high_id),low: witness(row.low_id),close: witness(row.close_id) }));
  const pending = (BigInt(coverage.captures)-BigInt(coverage.projected)).toString();
  const data = {
    schemaVersion: 'dusk-quote-history.v1',window,binding,candles,
    coverage: { cluster: pin.cluster,programId: pin.dusk.programId,idlSha256: pin.dusk.idlCanonicalSha256,
      protocolRevision: pin.revision,deploymentIdentitySha256: query.deploymentIdentitySha256,commitment: 'finalized',
      basis: 'sampled-program-spot-quotes.v1',priceScale: 'decimal-normalized-nad',historyRangeComplete: false,
      tradeOhlcAvailable: false,gapsFilled: false,projectionComplete: pending==='0',
      captures: coverage.captures,projectedCaptures: coverage.projected,pendingCaptures: pending,
      samples: counts.rows[0].samples,unavailableSamples: counts.rows[0].unavailable,watermark: coverage.watermark,
      firstSourceSlot: coverage.first_slot,lastSourceSlot: coverage.last_slot,
      firstCaptureAt: coverage.first_time?.toISOString() ?? null,lastCaptureAt: coverage.last_time?.toISOString() ?? null },
  };
  return { ...data,selectionHash: sha256(canonicalJson(data)) };
}

export async function listQuoteHistory(query: QuoteHistoryQuery) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const data = await readQuoteHistory(client,query);
    await client.query('COMMIT');
    return data;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
