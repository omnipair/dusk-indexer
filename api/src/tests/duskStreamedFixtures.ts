/** Streamed-event fixtures for disposable-database tests. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PoolClient } from 'pg';
import { loadPinnedProtocol } from '../config/duskProtocol';
import { checkpointFixture, fixtureKey, Q64 } from './duskYieldCheckpointFixtures';

const pin = loadPinnedProtocol();
export const streamedIdentity = [pin.cluster,pin.dusk.programId,pin.dusk.idlCanonicalSha256,pin.revision];
export const key = (index: number) => fixtureKey(index).toBase58();
export const fixtureMarket = { market: key(200),baseMint: key(206),quoteMint: key(207),ylp: key(203),baseHlp: key(204),quoteHlp: key(205) };

let nextSlot = 900_100_000;
/** One canonical streamed event, as the daemon writes it. */
export async function streamedEvent(client: PoolClient,name: string,payload: Record<string,unknown>,slot = nextSlot++,time?: string) {
  const eventKey = createHash('sha256').update(randomUUID()).digest('hex'),signature = `fixture-${eventKey}`;
  const inserted = await client.query(`INSERT INTO dusk_ingestion.event_observations
    (cluster,program_id,idl_hash,protocol_revision,event_key,transaction_signature,instruction_path,event_ordinal,
      slot,blockhash,commitment,event_name,payload_hash,decoded_payload,source)
    VALUES($1,$2,$3,$4,$5,$6,'{0,1}',0,$7,'unavailable:helius-atlas-ws','confirmed',$8,$9,$10,'disposable-integration-fixture')
    RETURNING observation_id`,
    [...streamedIdentity,eventKey,signature,slot,name,createHash('sha256').update(JSON.stringify(payload)).digest('hex'),JSON.stringify(payload)]);
  await client.query(`INSERT INTO dusk_ingestion.canonical_events
    (cluster,program_id,idl_hash,protocol_revision,event_key,observation_id,commitment) VALUES($1,$2,$3,$4,$5,$6,'confirmed')`,
    [...streamedIdentity,eventKey,inserted.rows[0].observation_id]);
  await client.query(`INSERT INTO dusk_ingestion.event_stream
    (time,cluster,program_id,event_name,market,transaction_signature,event_key,slot,payload,idl_hash,protocol_revision)
    VALUES(COALESCE($11::timestamptz,now()),$1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [streamedIdentity[0],streamedIdentity[1],name,payload.market ?? null,signature,eventKey,slot,JSON.stringify(payload),streamedIdentity[2],streamedIdentity[3],time ?? null]);
  return { eventKey,signature,slot };
}
export async function streamedMarket(client: PoolClient,market = fixtureMarket) {
  return streamedEvent(client,'MarketCreated',{ market: market.market,base_mint: market.baseMint,quote_mint: market.quoteMint,
    ylp_mint: market.ylp,base_hlp_mint: market.baseHlp,quote_hlp_mint: market.quoteHlp,config: {} });
}

/** The release as the daemon registers it, and its stream cursor. */
export async function streamedRelease(client: PoolClient,cursor: { slot: number | null; time: Date }) {
  const body = JSON.stringify({ revision: pin.revision,cluster: { name: pin.cluster,genesisHash: pin.genesisHash },
    programs: [pin.dusk,pin.leverageDelegate].map(p => ({ name: p.name,programId: p.programId,binary: { sha256: p.binarySha256 },
      idl: { canonicalSha256: p.idlCanonicalSha256 },deployment: p.deployment })) });
  await client.query('SELECT dusk_ingestion.record_deployment_interval($1,$2,$3,$4,$5,$6)',
    [pin.cluster,pin.revision,pin.historyFirstSlot,pin.historyFirstSlot+100,createHash('sha256').update(body).digest('hex'),body]);
  await client.query(`INSERT INTO dusk_ingestion.ingestion_cursors(cluster,program_id,idl_hash,protocol_revision,stream_name,commitment,next_slot,last_observed_slot,updated_at)
    VALUES($1,$2,$3,$4,'helius-atlas-ws','confirmed',$5,$6,$7)`,
    [...streamedIdentity,(cursor.slot ?? pin.historyFirstSlot)+1,cursor.slot,cursor.time]);
}

/** The price fixture's market: base fixtureKey(112) with 9 decimals, quote
 * fixtureKey(113) with 6, yLP fixtureKey(114). */
export const observedMarket = { market: checkpointFixture().source().market,baseMint: key(112),quoteMint: key(113),ylp: key(114) };

/** One MarketObserved event, as the permissionless crank emits it. */
export async function streamedObservation(client: PoolClient,options: {
  time: string; slot?: number; market?: string; baseMint?: string; quoteMint?: string; ylp?: string;
  baseSpotNad?: bigint; quoteSpotNad?: bigint; baseEmaNad?: bigint; quoteEmaNad?: bigint;
  ylpSupply?: bigint; baseReserve?: bigint; quoteReserve?: bigint;
  baseSwapIndex?: bigint; baseInterestIndex?: bigint; quoteSwapIndex?: bigint; quoteInterestIndex?: bigint;
  eligibleYlp?: bigint; governanceLockedYlp?: bigint;
}) {
  const side = (mint: string,decimals: number,reserve: bigint,spot: bigint,ema: bigint,swap: bigint,interest: bigint) => ({
    asset_mint: mint,asset_decimals: String(decimals),live_reserve: reserve.toString(),spot_price_nad: spot.toString(),
    price_ema_nad: ema.toString(),swap_fee_growth_index_q64: swap.toString(),interest_growth_index_q64: interest.toString(),
    borrow_index_nad: '1000000000' });
  const market = options.market ?? observedMarket.market;
  return streamedEvent(client,'MarketObserved',{ market,slot: String(options.slot ?? 0),ylp_mint: options.ylp ?? observedMarket.ylp,
    ylp_supply: (options.ylpSupply ?? 1_000_000n).toString(),
    eligible_ylp: (options.eligibleYlp ?? 0n).toString(),governance_locked_ylp: (options.governanceLockedYlp ?? 0n).toString(),
    base: side(options.baseMint ?? observedMarket.baseMint,9,options.baseReserve ?? 0n,options.baseSpotNad ?? 2_500_000_000n,
      options.baseEmaNad ?? 0n,options.baseSwapIndex ?? 3n*Q64,options.baseInterestIndex ?? 2n*Q64),
    quote: side(options.quoteMint ?? observedMarket.quoteMint,6,options.quoteReserve ?? 0n,options.quoteSpotNad ?? 0n,
      options.quoteEmaNad ?? 0n,options.quoteSwapIndex ?? 3n*Q64,options.quoteInterestIndex ?? 2n*Q64),
  },options.slot,options.time);
}

/** Point the process's dated reference policy at a fixture file: the quote
 * fixture mint at $1 from 2026-09-01. Call before the first price read. */
export function useFixtureReferences(references = [{ mint: key(113),priceUsd: '1',note: 'Explicit fixture reference' }]) {
  const pin = loadPinnedProtocol(),file = join(mkdtempSync(join(tmpdir(),'dusk-references-')),'references.json');
  writeFileSync(file,JSON.stringify({ schemaVersion: 'dusk-price-references.v1',cluster: pin.cluster,programId: pin.dusk.programId,
    idlSha256: pin.dusk.idlCanonicalSha256,protocolRevision: pin.revision,effectiveFrom: '2026-09-01T00:00:00Z',references }));
  process.env.DUSK_PRICE_REFERENCES_FILE = file;
}
