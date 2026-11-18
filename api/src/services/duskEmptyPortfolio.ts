/** Verified global market absence, never an inferred zero from a lagging stream. */
import { Connection,PublicKey } from '@solana/web3.js';
import { utils } from '@coral-xyz/anchor';
import { inflateSync } from 'node:zlib';
import type { PoolClient } from 'pg';
import pool from '../config/database';
import { canonicalJson,sha256,duskApiConfig,loadPinnedProtocol,loadCurrentProtocol } from '../config/duskProtocol';
import type { DuskPinnedProtocol,DuskPinnedProgram } from '../config/duskProtocol';
import { duskRawIdl } from './duskMarketSimulation';
import { deploymentEnvelopeAt } from './duskDeploymentService';
import { readFinalizedBlock } from './duskFinalizedBlock';
import { portfolioRevisionIdentity } from './duskPortfolioHistoryRevisions';

export interface EmptyMarketEvidence {
  schemaVersion:'dusk-market-catalog-observation.v1';commitment:'finalized';
  cluster:string;genesisHash:string;programId:string;idlHash:string;protocolRevision:string;
  slot:number;blockhash:string;blockTime:string;observedAt:string;marketDiscriminator:number[];
  markets:string[];deploymentIdentitySha256:string;
  deployments:{programId:string;programData:string;deploySlot:number;authority:string|null;binarySha256:string;idlSha256:string;allocatedBinaryBytes:number}[];
}
const loader='BPFLoaderUpgradeab1e11111111111111111111111';
const idlTag=Buffer.from(sha256('internal:IdlAccount'),'hex').subarray(0,8);
async function idlAddress(program:PublicKey){const[base]=PublicKey.findProgramAddressSync([],program);return PublicKey.createWithSeed(base,'anchor:idl',program);}
const metadata=(pin:DuskPinnedProgram)=>({programId:pin.programId,programData:pin.deployment.programData,deploySlot:pin.deployment.deploySlot,
  authority:pin.deployment.upgradeAuthority,binarySha256:pin.binarySha256,idlSha256:pin.idlCanonicalSha256,allocatedBinaryBytes:pin.deployment.allocatedBinaryBytes});
const invalid=()=>new Error('FINALIZED_INVARIANT: empty portfolio evidence differs from the pinned deployment');

export function validateMarketCatalogEvidence(e:EmptyMarketEvidence,pin=loadPinnedProtocol(),current=loadCurrentProtocol()):void{
  const tag=duskRawIdl().accounts?.find(row=>row.name==='Market')?.discriminator;
  if(e.schemaVersion!=='dusk-market-catalog-observation.v1'||e.commitment!=='finalized'
    ||canonicalJson([e.cluster,e.programId,e.idlHash,e.protocolRevision])!==canonicalJson(portfolioRevisionIdentity(pin))
    ||e.genesisHash!==pin.genesisHash||!Number.isSafeInteger(e.slot)||e.slot<=Math.max(current.dusk.deployment.deploySlot,current.leverageDelegate.deployment.deploySlot)
    ||!tag||canonicalJson(e.marketDiscriminator)!==canonicalJson(tag)||!Number.isFinite(Date.parse(e.blockTime))
    ||!Number.isFinite(Date.parse(e.observedAt))||Date.parse(e.blockTime)>Date.parse(e.observedAt)
    ||new PublicKey(e.blockhash).toBase58()!==e.blockhash||!/^[a-f0-9]{64}$/.test(e.deploymentIdentitySha256)
    ||!Array.isArray(e.markets)||e.markets.length>10000||new Set(e.markets).size!==e.markets.length
    ||e.markets.some(value=>new PublicKey(value).toBase58()!==value)
    ||canonicalJson(e.deployments)!==canonicalJson([metadata(current.dusk),metadata(current.leverageDelegate)]))throw invalid();
}

async function verifyExecutables(rpc:Connection,current:DuskPinnedProtocol,minSlot:number){
  const pins=[current.dusk,current.leverageDelegate],keys=await Promise.all(pins.flatMap(pin=>{
    const program=new PublicKey(pin.programId);return [Promise.resolve(program),Promise.resolve(new PublicKey(pin.deployment.programData)),idlAddress(program)];
  }));
  const read=await rpc.getMultipleAccountsInfoAndContext(keys,{commitment:'finalized',minContextSlot:minSlot});
  for(let i=0;i<pins.length;i++){
    const pin=pins[i],program=read.value[i*3],data=read.value[i*3+1],idl=read.value[i*3+2];
    if(!program?.executable||program.owner.toBase58()!==loader||program.data.length!==36||program.data.readUInt32LE(0)!==2
      ||new PublicKey(program.data.subarray(4)).toBase58()!==pin.deployment.programData||!data||data.executable||data.owner.toBase58()!==loader
      ||data.data.length!==45+pin.deployment.allocatedBinaryBytes||data.data.readUInt32LE(0)!==3||data.data[12]!==1
      ||data.data.readBigUInt64LE(4)!==BigInt(pin.deployment.deploySlot)||new PublicKey(data.data.subarray(13,45)).toBase58()!==pin.deployment.upgradeAuthority
      ||sha256(data.data.subarray(45))!==pin.binarySha256||!idl||idl.executable||idl.owner.toBase58()!==pin.programId
      ||idl.data.length<44||!idl.data.subarray(0,8).equals(idlTag))throw invalid();
    const length=idl.data.readUInt32LE(40);if(length<=0||length>idl.data.length-44)throw invalid();
    if(sha256(canonicalJson(JSON.parse(inflateSync(idl.data.subarray(44,44+length),{maxOutputLength:16*1024*1024}).toString())))!==pin.idlCanonicalSha256)throw invalid();
  }
  return read.context.slot;
}
/** Both code/IDL readbacks surround the actual finalized, full market scan. */
export async function captureMarketCatalogEvidence(minSlot:number,rpc=new Connection(duskApiConfig().rpcUrl,'finalized')):Promise<EmptyMarketEvidence>{
  const pin=loadPinnedProtocol(),current=loadCurrentProtocol();if(await rpc.getGenesisHash()!==pin.genesisHash)throw invalid();
  const floor=await verifyExecutables(rpc,current,minSlot),tag=duskRawIdl().accounts?.find(row=>row.name==='Market')?.discriminator;
  if(!tag)throw invalid();
  const read=await rpc.getProgramAccounts(new PublicKey(pin.dusk.programId),{commitment:'finalized',withContext:true,minContextSlot:Math.max(floor,minSlot),
    filters:[{memcmp:{offset:0,bytes:utils.bytes.bs58.encode(Buffer.from(tag))}}],dataSlice:{offset:0,length:0}});
  const block=await readFinalizedBlock(rpc,read.context.slot);await verifyExecutables(rpc,current,read.context.slot);
  const envelope=await deploymentEnvelopeAt(read.context.slot);
  const evidence:EmptyMarketEvidence={schemaVersion:'dusk-market-catalog-observation.v1',commitment:'finalized',cluster:pin.cluster,genesisHash:pin.genesisHash,
    programId:pin.dusk.programId,idlHash:pin.dusk.idlCanonicalSha256,protocolRevision:pin.revision,slot:read.context.slot,blockhash:block.blockhash,
    blockTime:new Date(block.blockTime*1000).toISOString(),observedAt:new Date().toISOString(),marketDiscriminator:tag,
    markets:read.value.map(row=>row.pubkey.toBase58()).sort(),deploymentIdentitySha256:envelope.deploymentIdentitySha256,
    deployments:[metadata(current.dusk),metadata(current.leverageDelegate)]};
  validateMarketCatalogEvidence(evidence,pin,current);return evidence;
}

/** Commit observations even if the subsequent absence assertion is rejected. */
export async function storeMarketCatalogEvidence(evidence:EmptyMarketEvidence):Promise<string>{
  validateMarketCatalogEvidence(evidence);const scope=portfolioRevisionIdentity(loadPinnedProtocol()),hash=sha256(canonicalJson([scope,evidence]));
  const result=await pool.query(`INSERT INTO dusk_ingestion.portfolio_market_catalog_observations
    (cluster,program_id,idl_hash,protocol_revision,slot,blockhash,observed_at,source,content_hash)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(cluster,program_id,idl_hash,protocol_revision,content_hash)
    DO NOTHING RETURNING observation_id::text`,[...scope,evidence.slot,evidence.blockhash,evidence.observedAt,JSON.stringify(evidence),hash]);
  if(result.rows[0])return result.rows[0].observation_id;
  const previous=await pool.query(`SELECT observation_id::text FROM dusk_ingestion.portfolio_market_catalog_observations
    WHERE cluster=$1 AND program_id=$2 AND idl_hash=$3 AND protocol_revision=$4 AND content_hash=$5`,[...scope,hash]);
  if(!previous.rows[0])throw invalid();return previous.rows[0].observation_id;
}
export async function assertMarketCatalogConsistency(client:PoolClient,pins:readonly DuskPinnedProtocol[]=[loadPinnedProtocol()]){
  const values:unknown[]=[],filters=pins.map(pin=>{const start=values.length;values.push(...portfolioRevisionIdentity(pin));return `(cluster=$${start+1} AND program_id=$${start+2} AND idl_hash=$${start+3} AND protocol_revision=$${start+4})`;});
  const rows=await client.query(`WITH catalogs AS (SELECT * FROM dusk_ingestion.portfolio_market_catalog_observations WHERE ${filters.join(' OR ')})
    SELECT 1 FROM catalogs GROUP BY cluster,program_id,idl_hash,protocol_revision,slot
      HAVING count(DISTINCT (blockhash,source->'markets'))>1
    UNION ALL SELECT 1 FROM catalogs c JOIN dusk_ingestion.portfolio_capture_observations o
      ON c.cluster=o.cluster AND c.program_id=o.program_id AND c.idl_hash=o.idl_hash AND c.protocol_revision=o.protocol_revision
        AND c.slot BETWEEN o.source_min_slot AND o.source_max_slot
      CROSS JOIN LATERAL jsonb_array_elements(o.source->'groups') g
      WHERE jsonb_array_length(c.source->'markets')=0 AND c.slot=(g->>'slot')::bigint LIMIT 1`,values);
  if(rows.rowCount)throw new Error('FINALIZED_INVARIANT: contradictory finalized market catalog observations');
}
export async function verifyEmptyCatalogStored(client:PoolClient,id:string,evidence:EmptyMarketEvidence){
  validateMarketCatalogEvidence(evidence);if(evidence.markets.length||!/^[1-9]\d*$/.test(id))throw invalid();
  await assertMarketCatalogConsistency(client);const scope=portfolioRevisionIdentity(loadPinnedProtocol());
  const row=(await client.query(`SELECT source,content_hash FROM dusk_ingestion.portfolio_market_catalog_observations
    WHERE observation_id=$5 AND cluster=$1 AND program_id=$2 AND idl_hash=$3 AND protocol_revision=$4`,[...scope,id])).rows[0];
  if(!row||canonicalJson(row.source)!==canonicalJson(evidence)||row.content_hash!==sha256(canonicalJson([scope,evidence])))throw invalid();
}
