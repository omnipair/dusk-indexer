import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { PoolClient } from 'pg';
import pool from '../config/database';
import { loadPinnedProtocol } from '../config/duskProtocol';

export const CLOSED_ORDER_INSTRUCTIONS = [
  'cancel_leverage_order','after_close_order',
  'cancel_leverage_entry_order','execute_leverage_entry_order',
  'cancel_hlp_order','execute_hlp_order',
] as const;
export interface OrderHistoryQuery { owner: string; market?: string; until: string; cursor?: string; limit: number; deploymentIdentitySha256: string }
const invalid = (): never => { throw Object.assign(new Error('Invalid order-history selection or cursor'), { status: 400 }); };
const integer = (v: unknown): v is string => typeof v === 'string' && /^(0|[1-9]\d{0,18})$/.test(v) && BigInt(v) <= (1n<<63n)-1n;
type Cursor = { scope: string; watermark: string; slot: string; key: string };
export function orderHistorySelection(query: OrderHistoryQuery) {
  const pin = loadPinnedProtocol();
  if (!Number.isSafeInteger(query.limit) || query.limit<1 || query.limit>100 || !/^[0-9a-f]{64}$/.test(query.deploymentIdentitySha256)
    || !Number.isFinite(Date.parse(query.until)) || Date.parse(query.until)>Date.now()) invalid();
  for (const address of [query.owner,...(query.market ? [query.market] : [])]) {
    try { if (new PublicKey(address).toBase58() !== address) invalid(); } catch { invalid(); }
  }
  const identity = [pin.cluster,pin.leverageDelegate.programId,pin.leverageDelegate.idlCanonicalSha256,pin.revision];
  const window = {owner:query.owner,market:query.market??null,until:new Date(query.until).toISOString()};
  const scope = createHash('sha256').update(JSON.stringify([identity,query.deploymentIdentitySha256,window,CLOSED_ORDER_INSTRUCTIONS])).digest('hex');
  let cursor: Cursor | null = null;
  if (query.cursor !== undefined) {
    try {
      if (query.cursor.length>2048 || !/^[\w-]+$/.test(query.cursor)) invalid();
      cursor=JSON.parse(Buffer.from(query.cursor,'base64url').toString('utf8'));
      if (!cursor || cursor.scope!==scope || !integer(cursor.watermark) || !integer(cursor.slot) || BigInt(cursor.slot)<BigInt(pin.historyFirstSlot) || typeof cursor.key!=='string') invalid();
      const parts=cursor!.key.split('|');
      if (parts.length!==6 || identity.some((v,i)=>parts[i]!==v) || !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(parts[4]) || !parts[5].split('.').every(p=>/^(0|[1-9]\d{0,4})$/.test(p)&&Number(p)<=65535)) invalid();
    } catch { invalid(); }
  }
  return {pin,identity,window,scope,cursor};
}

/** Repeatable-read pagination over immutable successful instruction observations. */
export async function readOrderHistory(client: PoolClient, query: OrderHistoryQuery) {
  const {pin,identity,window,scope,cursor}=orderHistorySelection(query);
  const conflict=await client.query(`SELECT 1 FROM dusk_ingestion.order_instruction_observations
    WHERE cluster=$1 AND program_id=$2 AND idl_hash=$3 AND protocol_revision=$4 GROUP BY instruction_key HAVING count(DISTINCT evidence_sha256)>1 LIMIT 1`,identity);
  if (conflict.rowCount) throw new Error('FINALIZED_INVARIANT: contradictory order-history observations');
  const late=await client.query(`SELECT 1 FROM dusk_ingestion.order_instruction_observations o JOIN dusk_ingestion.order_history_scans s
    USING(cluster,program_id,idl_hash,protocol_revision) WHERE o.cluster=$1 AND o.program_id=$2 AND o.idl_hash=$3 AND o.protocol_revision=$4
    AND o.slot BETWEEN s.from_slot AND s.through_slot AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(s.transactions) r WHERE r->>'signature'=o.signature AND (r->>'slot')::bigint=o.slot AND r->>'blockhash'=o.blockhash AND r->'instructionKeys' ? o.instruction_key) LIMIT 1`,identity);
  if (late.rowCount) throw new Error('FINALIZED_INVARIANT: order history contradicts completed scan');
  const scan=await client.query<{through_slot:string;through_block_time:Date;release_block_time:Date;completed_at:Date}>(`SELECT through_slot::text,through_block_time,release_block_time,completed_at FROM dusk_ingestion.order_history_scans
    WHERE cluster=$1 AND program_id=$2 AND idl_hash=$3 AND protocol_revision=$4 ORDER BY through_slot DESC LIMIT 1`,identity);
  if (!scan.rows[0]) throw Object.assign(new Error('Delegate order-history scan has not completed'),{status:503});
  const latest=(await client.query<{watermark:string}>(`SELECT COALESCE(max(observation_id),0)::text AS watermark FROM dusk_ingestion.order_instruction_observations WHERE cluster=$1 AND program_id=$2 AND idl_hash=$3 AND protocol_revision=$4`,identity)).rows[0].watermark;
  if (cursor && BigInt(cursor.watermark)>BigInt(latest)) invalid();
  const watermark=cursor?.watermark??latest;
  type Row={instruction_key:string;observation_id:string;instruction_name:string;order_address:string;owner_address:string;market:string|null;signature:string;slot:string;blockhash:string;instruction_path:number[];block_time:Date};
  const rows=await client.query<Row>(`SELECT o.instruction_key,o.observation_id::text,o.instruction_name,o.order_address,o.owner_address,
    COALESCE(o.market_address,created.market_address) AS market,o.signature,o.slot::text,o.blockhash,o.instruction_path,o.block_time
    FROM dusk_ingestion.order_instruction_observations o
    LEFT JOIN LATERAL (SELECT c.market_address FROM dusk_ingestion.order_instruction_observations c WHERE
      (c.cluster,c.program_id,c.idl_hash,c.protocol_revision,c.order_address,c.owner_address)=(o.cluster,o.program_id,o.idl_hash,o.protocol_revision,o.order_address,o.owner_address)
      AND c.instruction_name LIKE 'create_%' AND c.observation_id<=$5::bigint AND (c.slot,c.instruction_path)<=(o.slot,o.instruction_path)
      ORDER BY c.slot DESC,c.instruction_path DESC LIMIT 1) created ON true
    WHERE o.cluster=$1 AND o.program_id=$2 AND o.idl_hash=$3 AND o.protocol_revision=$4 AND o.observation_id<=$5::bigint
      AND o.owner_address=$6 AND o.instruction_name=ANY($7::text[]) AND o.block_time<=$8
      AND ($9::text IS NULL OR COALESCE(o.market_address,created.market_address)=$9)
      AND ($10::bigint IS NULL OR (o.slot,o.instruction_key)<($10::bigint,$11::text))
    ORDER BY o.slot DESC,o.instruction_key DESC LIMIT $12`,[...identity,watermark,window.owner,CLOSED_ORDER_INSTRUCTIONS,window.until,window.market,cursor?.slot??null,cursor?.key??null,query.limit+1]);
  const page=rows.rows.slice(0,query.limit), last=page.at(-1), hasMore=rows.rows.length>query.limit;
  const nextCursor=hasMore&&last?Buffer.from(JSON.stringify({scope,watermark,slot:last.slot,key:last.instruction_key})).toString('base64url'):null;
  const scanned=scan.rows[0];
  return {schemaVersion:'dusk-order-history.v1',window,
    orders:page.map(row=>({instructionKey:row.instruction_key,observationId:row.observation_id,instructionName:row.instruction_name,
      order:row.order_address,owner:row.owner_address,market:row.market,signature:row.signature,slot:row.slot,blockhash:row.blockhash,instructionPath:row.instruction_path,time:row.block_time.toISOString()})),
    pagination:{limit:query.limit,cursor:query.cursor??null,nextCursor,hasMore,watermark},
    coverage:{cluster:pin.cluster,programId:pin.leverageDelegate.programId,idlSha256:pin.leverageDelegate.idlCanonicalSha256,protocolRevision:pin.revision,
      deploymentIdentitySha256:query.deploymentIdentitySha256,commitment:'finalized',basis:'finalized-delegate-instructions.v1',historyRangeComplete:false,
      firstSlot:String(pin.historyFirstSlot),throughSlot:scanned.through_slot,throughTime:scanned.through_block_time.toISOString(),completedAt:scanned.completed_at.toISOString()},
  };
}
export async function listOrderHistory(query:OrderHistoryQuery) {
  const client=await pool.connect();
  try { await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); const data=await readOrderHistory(client,query); await client.query('COMMIT'); return data; }
  catch(error){await client.query('ROLLBACK');throw error;} finally{client.release();}
}
