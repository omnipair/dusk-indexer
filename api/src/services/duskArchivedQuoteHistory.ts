import { PoolClient } from 'pg';
import { BorshCoder, Idl } from '@coral-xyz/anchor';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import pool from '../config/database';
import { loadPinnedProtocol, loadProtocolAt } from '../config/duskProtocol';
import { DuskDeploymentEnvelope } from './duskDeploymentService';
import { assertPinnedHistoryDeployment, historyDeploymentIdentities } from './duskHistoryDeployment';
import { verifyStoredPriceCapture } from './duskPrices';
import { QuoteHistoryQuery, quoteHistoryState, readCapturedQuoteHistory } from './duskQuoteHistory';

export const ARCHIVED_QUOTE_REVISION = 'devnet-2026-09-13-9973dea';
export const PREVIOUS_QUOTE_REVISION = 'devnet-2026-09-18-1fa72d3';
export const RECENT_QUOTE_REVISION = 'devnet-2026-09-18-932018a';
export const PRIOR_ACTIVE_QUOTE_REVISION = 'devnet-2026-09-27-5644e5d';
export const PREVIOUS_ACTIVE_QUOTE_REVISION = 'devnet-2026-10-25-296263d';
export const LAST_ACTIVE_QUOTE_REVISION = 'devnet-2026-10-26-cd6f1ec';
const ORACLE_V7_REVISION = 'next-2026-10-31-8fadcc31';
const LAYOUT_V8_REVISION = 'next-2026-10-31-layouts';
const ROTATED_PROGRAM_REVISION = 'devnet-2026-11-01-tranches';
const PREVIOUS_ACTIVE_REVISION = 'devnet-2026-11-01-tranches-fresh';
const PREVIOUS_GOVERNANCE_REVISION = 'devnet-2026-11-02-governable-tranches';
const OPERATORS_REVISION = 'devnet-2026-11-06-operators';
const COMBINED_REVISION = 'devnet-2026-11-09-combined-layout14';
const FRESH_LAYOUT14_REVISION = 'devnet-2026-11-09-fresh-layout14';
const ACTIVE_REVISION = 'devnet-2026-11-12-fresh-layout15';
const FRESH_LAYOUT14_DUSK_PROGRAM_ID = '2rYBVfGubUVbHrLeut6Dn4A9ShM695dGSPCErdsGo16Y';
const ARCHIVED_DUSK_PROGRAM_ID = 'JA8Zxxm4t4zopBL8e3dQQXWfQ3a5pBUPY9Sp9RnybV2X';
const successors: Record<string, string> = {
  [ARCHIVED_QUOTE_REVISION]: PREVIOUS_QUOTE_REVISION,
  [PREVIOUS_QUOTE_REVISION]: RECENT_QUOTE_REVISION,
  [RECENT_QUOTE_REVISION]: PRIOR_ACTIVE_QUOTE_REVISION,
  [PRIOR_ACTIVE_QUOTE_REVISION]: PREVIOUS_ACTIVE_QUOTE_REVISION,
  [PREVIOUS_ACTIVE_QUOTE_REVISION]: LAST_ACTIVE_QUOTE_REVISION,
  [LAST_ACTIVE_QUOTE_REVISION]: ORACLE_V7_REVISION,
  [ORACLE_V7_REVISION]: LAYOUT_V8_REVISION,
  [LAYOUT_V8_REVISION]: ROTATED_PROGRAM_REVISION,
  [ROTATED_PROGRAM_REVISION]: PREVIOUS_ACTIVE_REVISION,
  [PREVIOUS_ACTIVE_REVISION]: PREVIOUS_GOVERNANCE_REVISION,
  [PREVIOUS_GOVERNANCE_REVISION]: OPERATORS_REVISION,
  [OPERATORS_REVISION]: COMBINED_REVISION,
  [COMBINED_REVISION]: FRESH_LAYOUT14_REVISION,
  [FRESH_LAYOUT14_REVISION]: ACTIVE_REVISION,
};

/** Historical display only. Each release keeps its original tuple, envelope,
 * IDL decoder and immutable source bytes; no rows are copied or relabelled. */
export async function readArchivedQuoteHistory(client: PoolClient,query: QuoteHistoryQuery, revision: string) {
  const active = loadPinnedProtocol();
  if (!Object.prototype.hasOwnProperty.call(successors, revision) || revision === active.revision
      || active.revision !== ACTIVE_REVISION)
    throw Object.assign(new Error('Unsupported quote archive'),{status:400});
  const root = resolve(process.env.DUSK_PROTOCOL_DIR?.trim() || resolve(__dirname,'../../../protocol'),'archive',revision);
  const pin = loadProtocolAt(root);
  if (pin.revision !== revision || pin.cluster !== active.cluster || pin.genesisHash !== active.genesisHash
    || pin.dusk.programId !== (revision === FRESH_LAYOUT14_REVISION
      ? FRESH_LAYOUT14_DUSK_PROGRAM_ID : ARCHIVED_DUSK_PROGRAM_ID))
    throw new Error('Quote archive is not part of this deployment lineage');
  const coder = new BorshCoder(JSON.parse(readFileSync(resolve(root,'idl/dusk.json'),'utf8')) as Idl);
  const successor = successors[revision] === active.revision ? active
    : loadProtocolAt(resolve(root, '..', successors[revision]));
  const intentionalProgramRotation = revision === ROTATED_PROGRAM_REVISION
    || revision === COMBINED_REVISION || revision === FRESH_LAYOUT14_REVISION;
  if (successor.revision !== successors[revision] || successor.cluster !== pin.cluster
    || successor.genesisHash !== pin.genesisHash
    || (!intentionalProgramRotation && successor.dusk.programId !== pin.dusk.programId)
    || successor.dusk.deployment.deploySlot <= pin.dusk.deployment.deploySlot)
    throw new Error('Invalid quote archive successor');
  const lastSlot = successor.dusk.deployment.deploySlot-1;

  const saved = await client.query<{envelope:DuskDeploymentEnvelope}>(`SELECT envelope FROM dusk_ingestion.capture_deployments
    WHERE cluster=$1 AND program_id=$2 AND idl_hash=$3 AND protocol_revision=$4 ORDER BY deployment_identity_sha256 LIMIT 1`,
    [pin.cluster,pin.dusk.programId,pin.dusk.idlCanonicalSha256,pin.revision]);
  const deployment = saved.rows[0]?.envelope;
  if (!deployment) throw new Error('Registered quote archive unavailable');
  assertPinnedHistoryDeployment(deployment,pin);
  const selection = {...query,deployment,deploymentIdentitySha256:deployment.deploymentIdentitySha256};
  const deployments = await historyDeploymentIdentities(client,selection,pin);
  const historyRevision = await quoteHistoryState(client,query.market,pin);
  const history = await readCapturedQuoteHistory(client,selection,{revision:historyRevision,deployments,
    archive:{pin,lastSlot,verify:row=>verifyStoredPriceCapture(row,{pin,coder})}});
  return {schemaVersion:'dusk-quote-history-archive.v1',deployment,history};
}

export async function listArchivedQuoteHistory(query: QuoteHistoryQuery, revision: string) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const result=await readArchivedQuoteHistory(client,query,revision);
    await client.query('COMMIT');
    return result;
  } catch(error) {await client.query('ROLLBACK');throw error;}
  finally {client.release();}
}
