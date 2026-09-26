/** Streamed-event fixtures for disposable-database tests. */
import { createHash, randomUUID } from 'node:crypto';
import { PoolClient } from 'pg';
import { loadPinnedProtocol } from '../config/duskProtocol';
import { fixtureKey } from './duskYieldCheckpointFixtures';

const pin = loadPinnedProtocol();
export const streamedIdentity = [pin.cluster,pin.dusk.programId,pin.dusk.idlCanonicalSha256,pin.revision];
export const key = (index: number) => fixtureKey(index).toBase58();
export const fixtureMarket = { market: key(200),baseMint: key(206),quoteMint: key(207),ylp: key(203),baseHlp: key(204),quoteHlp: key(205) };

let nextSlot = 900_100_000;
/** One canonical streamed event, as the daemon writes it. */
export async function streamedEvent(client: PoolClient,name: string,payload: Record<string,unknown>,slot = nextSlot++) {
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
    VALUES(now(),$1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [streamedIdentity[0],streamedIdentity[1],name,payload.market ?? null,signature,eventKey,slot,JSON.stringify(payload),streamedIdentity[2],streamedIdentity[3]]);
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
