import { BorshCoder } from '@coral-xyz/anchor';
import { AccountInfo, PublicKey } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, unpackAccount } from '@solana/spl-token';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PoolClient } from 'pg';
import pool from '../config/database';
import { canonicalJson, loadPinnedProtocol, sha256 } from '../config/duskProtocol';
import { deploymentEnvelope } from './duskDeploymentService';
import { captureMarketSimulation, duskRawIdl, MarketSimulationSnapshot, SnapshotAccount } from './duskMarketSimulation';
import { nativeFields, nativeKey, PortfolioKind, projectPortfolioComponent, totalPortfolioComponents } from './duskPortfolioMath';
import { parsePriceReferences, priceMarketBindings } from './duskPriceMath';
import { assertNativeEvidenceConsistent } from './duskNativeEvidence';

const identity = () => {
  const pin = loadPinnedProtocol();
  return [pin.cluster,pin.dusk.programId,pin.dusk.idlCanonicalSha256,pin.revision];
};
export interface PortfolioCatalogItem { address: string; market: string; owner: string; kind: PortfolioKind; sourceSlot: number }
export interface PortfolioCatalog {
  accountScanId: string; accountSlot: number; lpScanIds: string[]; lpScanSlots: number[]; sourceFloor: number;
  markets: string[]; items: PortfolioCatalogItem[]; knownOwners: string[];
}
export interface PortfolioCaptureSource {
  schemaVersion: 'dusk-portfolio-capture.v1'; catalog: PortfolioCatalog; groups: MarketSimulationSnapshot[];
  references: unknown; observedAt: string; deploymentIdentitySha256: string; maxCatalogAgeSlots: number;
}
const checkedSlot = (value: number) => {
  if (!Number.isSafeInteger(value) || value<0) throw new Error('Invalid portfolio source slot');
  return value;
};
const sourceHash = (source: PortfolioCaptureSource) => {
  const { observedAt: _observedAt,groups,...durable } = source;
  return sha256(canonicalJson([identity(),{ ...durable,groups: groups.map(({ observedAt: _time,...group }) => group) }]));
};
function coordinates(source: PortfolioCaptureSource) {
  if (!source.groups.length || source.groups.length>5000) throw new Error('Invalid bounded portfolio market groups');
  const slots = source.groups.map((group) => checkedSlot(group.slot));
  const times = source.groups.map((group) => Date.parse(group.blockTime));
  if (times.some((time) => !Number.isFinite(time)) || !Number.isFinite(Date.parse(source.observedAt))) throw new Error('Invalid portfolio capture time');
  return { minSlot: Math.min(...slots),maxSlot: Math.max(...slots),captureTime: new Date(Math.max(...times)).toISOString() };
}

/** Discovery only: every returned address is read again at its valuation bank. */
export async function readPortfolioCatalog(client: PoolClient): Promise<PortfolioCatalog> {
  const active = identity();
  await assertNativeEvidenceConsistent(client,active);
  const scan = await client.query(`SELECT scan_id::text,slot::text FROM dusk_ingestion.account_scans
    WHERE cluster=$1 AND program_id=$2 AND idl_hash=$3 AND protocol_revision=$4 AND applied_at IS NOT NULL ORDER BY slot DESC,scan_id DESC LIMIT 1`,active);
  if (!scan.rows[0]) throw new Error('A complete native account scan is required for portfolio capture');
  const accountScanId = scan.rows[0].scan_id,accountSlot = checkedSlot(Number(scan.rows[0].slot));
  const markets = await client.query(`SELECT m.account_pubkey,o.raw_account,m.scan_id::text FROM dusk_ingestion.native_markets m
    JOIN dusk_ingestion.account_observations o USING(scan_id,account_pubkey)
    WHERE cluster=$1 AND program_id=$2 AND idl_hash=$3 AND protocol_revision=$4 ORDER BY m.account_pubkey`,active);
  if (!markets.rowCount) throw new Error('Portfolio capture has no discovered markets');
  const marketAddresses = markets.rows.map((row) => nativeKey(row.account_pubkey));
  const expectedMints = new Map<string,{ market: string; kind: PortfolioKind }>();
  const decoder = new BorshCoder(duskRawIdl());
  for (const row of markets.rows) {
    if (row.scan_id !== accountScanId) throw new Error('Native market projection is behind its completed scan');
    // The Rust JSON projection stringifies integers, including hash bytes.
    // Decode the immutable account for SDK/IDL-shaped validation instead.
    const state = nativeFields(decoder.accounts.decode('Market',row.raw_account));
    priceMarketBindings(active[1],row.account_pubkey,state);
    for (const [kind,mint] of [['ylp',state.ylp_mint],['base_hlp',nativeFields(state.base_side).hlp_mint],['quote_hlp',nativeFields(state.quote_side).hlp_mint]] as const) {
      const address = nativeKey(mint);
      if (expectedMints.has(address)) throw new Error('Portfolio LP mint is shared by different market bindings');
      expectedMints.set(address,{ market: row.account_pubkey,kind });
    }
  }
  const positions = await client.query(`SELECT account_pubkey,account_name,market,owner,source_slot::text,scan_id::text FROM dusk_ingestion.native_positions
    WHERE cluster=$1 AND program_id=$2 AND idl_hash=$3 AND protocol_revision=$4 ORDER BY account_pubkey`,active);
  const items: PortfolioCatalogItem[] = positions.rows.map((row) => {
    if (row.scan_id !== accountScanId || !marketAddresses.includes(row.market)) throw new Error('Position catalog is incomplete');
    return { address: nativeKey(row.account_pubkey),owner: nativeKey(row.owner),market: row.market,
      kind: row.account_name === 'BorrowPosition' ? 'borrow' : 'leverage',sourceSlot: checkedSlot(Number(row.source_slot)) };
  });
  const lpScans = await client.query(`SELECT scan_id::text,lp_mint,market,token_kind,slot::text FROM dusk_ingestion.latest_lp_token_scans
    WHERE cluster=$1 AND program_id=$2 AND idl_hash=$3 AND protocol_revision=$4 ORDER BY lp_mint`,active);
  const selected = lpScans.rows.filter((row) => expectedMints.has(row.lp_mint));
  if (selected.length !== expectedMints.size) throw new Error('Complete ownership scans for every portfolio LP mint are required');
  for (const row of selected) {
    const expected = expectedMints.get(row.lp_mint)!;
    if (row.market !== expected.market || row.token_kind !== expected.kind) throw new Error('LP scan differs from native market bindings');
  }
  const lpScanIds = selected.map((row) => row.scan_id);
  const tokens = await client.query(`SELECT o.token_account,o.owner,s.market,s.token_kind,s.slot::text FROM dusk_ingestion.lp_token_observations o
    JOIN dusk_ingestion.lp_token_scans s USING(scan_id) WHERE scan_id=ANY($1::bigint[]) ORDER BY o.token_account`,[lpScanIds]);
  for (const row of tokens.rows) items.push({ address: nativeKey(row.token_account),owner: nativeKey(row.owner),market: row.market,
    kind: row.token_kind,sourceSlot: checkedSlot(Number(row.slot)) });
  // Preserve previous owners after closure or a token-account authority change.
  const pastOwners = await client.query(`SELECT owner FROM dusk_ingestion.portfolio_checkpoints
      WHERE cluster=$1 AND program_id=$2 AND idl_hash=$3 AND protocol_revision=$4
    UNION SELECT decoded_fields->>'owner' FROM dusk_ingestion.account_projections
      WHERE cluster=$1 AND program_id=$2 AND idl_hash=$3 AND protocol_revision=$4 AND account_name IN ('BorrowPosition','LeveragePosition')
    UNION SELECT o.owner FROM dusk_ingestion.lp_token_observations o JOIN dusk_ingestion.lp_token_scans s USING(scan_id)
      WHERE s.cluster=$1 AND s.program_id=$2 AND s.idl_hash=$3 AND s.protocol_revision=$4 AND s.applied_at IS NOT NULL`,active);
  const knownOwners = [...new Set([...items.map((item) => item.owner),...pastOwners.rows.map((row) => nativeKey(row.owner))])].sort();
  if (items.length>100000 || knownOwners.length>100000) throw new Error('Portfolio catalog exceeds the bounded capture capacity');
  const lpScanSlots = selected.map((row) => checkedSlot(Number(row.slot)));
  return { accountScanId,accountSlot,lpScanIds,lpScanSlots,markets: marketAddresses,items: items.sort((a,b) => a.address.localeCompare(b.address)),knownOwners,
    sourceFloor: Math.max(accountSlot,...lpScanSlots) };
}

function rawAccount(value: SnapshotAccount,program: string): AccountInfo<Buffer> {
  const data = Buffer.from(value.data,'base64');
  if (value.owner !== program || value.executable || !data.length || data.toString('base64') !== value.data) throw new Error('Invalid portfolio raw account owner/bytes');
  return { owner: new PublicKey(program),executable: false,data,lamports: 0,rentEpoch: 0 };
}

/** Pure replay: saved discovery, account bytes and dated references are the inputs. */
export function projectPortfolioSource(source: PortfolioCaptureSource) {
  const pin = loadPinnedProtocol(),decoder = new BorshCoder(duskRawIdl()),catalog = source.catalog,coords = coordinates(source);
  if (source.schemaVersion !== 'dusk-portfolio-capture.v1' || !Number.isSafeInteger(source.maxCatalogAgeSlots) || source.maxCatalogAgeSlots<1
    || source.maxCatalogAgeSlots>2500 || coords.maxSlot-checkedSlot(catalog.accountSlot)>source.maxCatalogAgeSlots
    || coords.minSlot<checkedSlot(catalog.sourceFloor) || catalog.sourceFloor<catalog.accountSlot
    || catalog.lpScanSlots.length !== catalog.lpScanIds.length || catalog.lpScanIds.length !== catalog.markets.length*3
    || catalog.sourceFloor !== Math.max(catalog.accountSlot,...catalog.lpScanSlots)
    || catalog.lpScanSlots.some((slot) => coords.maxSlot-checkedSlot(slot)>source.maxCatalogAgeSlots))
    throw new Error('Portfolio catalog is stale or has invalid coordinates');
  parsePriceReferences(source.references,pin);
  const expected = new Map(catalog.items.map((item) => [nativeKey(item.address),item]));
  if (expected.size !== catalog.items.length || new Set(catalog.markets).size !== catalog.markets.length) throw new Error('Duplicate portfolio discovery addresses');
  const seen = new Set<string>(),markets = new Set<string>(),owners = new Map<string,ReturnType<typeof projectPortfolioComponent>[]>();
  for (const owner of catalog.knownOwners) owners.set(nativeKey(owner),[]);
  for (const item of catalog.items) {
    if (!catalog.markets.includes(item.market) || item.sourceSlot>catalog.sourceFloor || !owners.has(item.owner)
      || !['borrow','leverage','ylp','base_hlp','quote_hlp'].includes(item.kind)) throw new Error('Portfolio catalog bindings are incomplete');
    checkedSlot(item.sourceSlot);
  }
  const closed: string[] = [],moved: { address: string; previousOwner: string; owner: string }[] = [];
  for (const group of source.groups) {
    if ((group.commitment !== undefined && group.commitment !== 'finalized') || !catalog.markets.includes(group.market) || group.accounts.length>20 || group.deploymentIdentitySha256 !== source.deploymentIdentitySha256
      || group.previewUnavailable !== (group.preview === null) || (group.preview === null ? group.basis !== 'rpc-account' : group.basis !== 'simulation-post-state'))
      throw new Error('Portfolio group identity or state basis differs');
    markets.add(group.market);
    const market = decoder.accounts.decode('Market',rawAccount(group.marketAccount,pin.dusk.programId).data);
    priceMarketBindings(pin.dusk.programId,group.market,market);
    const preview = group.preview === null ? null : decoder.types.decode('MarketPreview',Buffer.from(group.preview,'base64'));
    for (const entry of group.accounts) {
      const item = expected.get(entry.address);
      if (!item || seen.has(entry.address) || item.market !== group.market) throw new Error('Portfolio snapshot omits or duplicates its discovery set');
      seen.add(entry.address);
      if (!entry.account) { closed.push(entry.address); continue; }
      let state: unknown;
      if (item.kind === 'borrow' || item.kind === 'leverage') {
        state = decoder.accounts.decode(item.kind === 'borrow' ? 'BorrowPosition' : 'LeveragePosition',rawAccount(entry.account,pin.dusk.programId).data);
      } else {
        const token = unpackAccount(new PublicKey(entry.address),rawAccount(entry.account,TOKEN_2022_PROGRAM_ID.toBase58()),TOKEN_2022_PROGRAM_ID);
        if (!token.isInitialized) throw new Error('Portfolio LP account is not initialized');
        state = { mint: token.mint,owner: token.owner,amount: token.amount };
      }
      const component = { ...projectPortfolioComponent({ pin,kind: item.kind,address: entry.address,marketAddress: group.market,market,preview,state,
        slot: group.slot,blockTime: group.blockTime,references: source.references }),sourceBlockhash: group.blockhash,stateBasis: group.basis };
      if (component.owner !== item.owner) moved.push({ address: entry.address,previousOwner: item.owner,owner: component.owner });
      if (!owners.has(component.owner)) owners.set(component.owner,[]);
      owners.get(component.owner)!.push(component);
    }
  }
  if (seen.size !== expected.size || markets.size !== catalog.markets.length) throw new Error('Portfolio capture does not cover its complete catalog');
  const referenceHash = sha256(canonicalJson(parsePriceReferences(source.references,pin)));
  return { ...coords,owners: [...owners].sort(([a],[b]) => a.localeCompare(b)).map(([owner,components]) => ({ owner,
    components: components.sort((a,b) => a.address.localeCompare(b.address)),valuations: totalPortfolioComponents(components) })),
    coverage: { basis: 'sampled-native-positions.v1',catalogComplete: true,atomicAcrossMarkets: false,historyComplete: false,
      discoveryAtomicWithValuation: false,completeAtValuationSlot: false,
      accountScanId: catalog.accountScanId,accountScanSlot: String(catalog.accountSlot),lpScanIds: catalog.lpScanIds,
      catalogMaxAgeSlots: source.maxCatalogAgeSlots,catalogLagSlots: coords.maxSlot-catalog.accountSlot,referenceHash,
      marketCount: markets.size,capturedAccountCount: seen.size,closedAccounts: closed.sort(),ownerChanges: moved,
      previewUnavailableMarkets: [...new Set(source.groups.filter((group) => group.previewUnavailable).map((group) => group.market))].sort(),
      includesWalletBalances: false,includesUnclaimedYield: false,currentTransactionQuote: false } };
}

/** Caller owns the transaction. Commit this evidence before attempting replay. */
export async function storePortfolioCapture(client: PoolClient,source: PortfolioCaptureSource): Promise<string> {
  const coords = coordinates(source),active = identity(),hash = sourceHash(source);
  const inserted = await client.query(`INSERT INTO dusk_ingestion.portfolio_capture_observations
    (cluster,program_id,idl_hash,protocol_revision,source_min_slot,source_max_slot,capture_time,observed_at,deployment_identity_sha256,source,content_hash)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(cluster,program_id,idl_hash,protocol_revision,content_hash) DO NOTHING RETURNING capture_id::text`,
    [...active,coords.minSlot,coords.maxSlot,coords.captureTime,source.observedAt,source.deploymentIdentitySha256,JSON.stringify(source),hash]);
  if (!inserted.rows[0]) {
    const previous = await client.query('SELECT capture_id::text FROM dusk_ingestion.portfolio_capture_observations WHERE cluster=$1 AND program_id=$2 AND idl_hash=$3 AND protocol_revision=$4 AND content_hash=$5',[...active,hash]);
    if (!previous.rows[0]) throw new Error('FINALIZED_INVARIANT: saved portfolio source disappeared');
    return previous.rows[0].capture_id;
  }
  const id = inserted.rows[0].capture_id;
  for (const group of source.groups) {
    const facts = [{ address: group.market,basis: group.basis,state: [group.marketAccount,group.preview] },
      ...group.accounts.map((entry) => ({ address: entry.address,basis: 'rpc-account',state: entry.account }))];
    for (const fact of facts) {
      const stateHash = sha256(canonicalJson([group.blockhash,fact.state]));
      await client.query(`INSERT INTO dusk_ingestion.portfolio_account_evidence(capture_id,account,slot,basis,blockhash,state_hash)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,[id,fact.address,group.slot,fact.basis,group.blockhash,stateHash]);
    }
  }
  return id;
}
async function assertNoPortfolioConflict(client: PoolClient) {
  const conflicts = await client.query(`SELECT 1 FROM dusk_ingestion.portfolio_account_evidence e JOIN dusk_ingestion.portfolio_capture_observations o USING(capture_id)
    WHERE cluster=$1 AND program_id=$2 AND idl_hash=$3 AND protocol_revision=$4
    GROUP BY account,slot,basis HAVING count(DISTINCT (blockhash,state_hash))>1 LIMIT 1`,identity());
  if (conflicts.rowCount) throw Object.assign(new Error('FINALIZED_INVARIANT: contradictory finalized portfolio account evidence'),{ status: 503 });
}
export async function projectPortfolioCapture(client: PoolClient,captureId: string): Promise<number> {
  const active = identity();
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`dusk:portfolio:${JSON.stringify(active)}`]);
  await assertNoPortfolioConflict(client);
  const result = await client.query(`SELECT * FROM dusk_ingestion.portfolio_capture_observations WHERE cluster=$1 AND program_id=$2 AND idl_hash=$3 AND protocol_revision=$4 AND capture_id=$5`,[...active,captureId]);
  const row = result.rows[0];
  if (!row || sourceHash(row.source) !== row.content_hash) throw new Error('FINALIZED_INVARIANT: saved portfolio identity/hash mismatch');
  const previous = await client.query('SELECT owner_count FROM dusk_ingestion.portfolio_capture_projections WHERE capture_id=$1',[captureId]);
  if (previous.rows[0]) return previous.rows[0].owner_count;
  const projected = projectPortfolioSource(row.source);
  const coverage = { ...projected.coverage,sourceHash: row.content_hash,deploymentIdentitySha256: row.deployment_identity_sha256 };
  for (const owner of projected.owners) await client.query(`INSERT INTO dusk_ingestion.portfolio_checkpoints
    (cluster,program_id,idl_hash,protocol_revision,owner,bucket,observed_at,source_min_slot,source_max_slot,components,coverage,valuations,capture_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,[...active,owner.owner,projected.captureTime,row.observed_at,projected.minSlot,projected.maxSlot,
      JSON.stringify(owner.components),JSON.stringify(coverage),JSON.stringify(owner.valuations),captureId]);
  await client.query('INSERT INTO dusk_ingestion.portfolio_capture_projections(capture_id,owner_count) VALUES($1,$2)',[captureId,projected.owners.length]);
  return projected.owners.length;
}
export async function projectPortfolioCaptureBatch(client: PoolClient,limit = 10): Promise<number> {
  if (!Number.isSafeInteger(limit) || limit<1 || limit>10) throw new Error('Invalid portfolio replay batch size');
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`dusk:portfolio:${JSON.stringify(identity())}`]);
  await assertNoPortfolioConflict(client);
  const rows = await client.query(`SELECT o.capture_id::text FROM dusk_ingestion.portfolio_capture_observations o
    WHERE cluster=$1 AND program_id=$2 AND idl_hash=$3 AND protocol_revision=$4
      AND NOT EXISTS(SELECT 1 FROM dusk_ingestion.portfolio_capture_projections p WHERE p.capture_id=o.capture_id)
    ORDER BY source_max_slot,capture_id LIMIT $5`,[...identity(),limit]);
  for (const row of rows.rows) await projectPortfolioCapture(client,row.capture_id);
  return rows.rows.length;
}
export async function replayPortfolioCaptures(): Promise<number> {
  const client = await pool.connect();
  try { await client.query('BEGIN'); const count = await projectPortfolioCaptureBatch(client); await client.query('COMMIT'); return count; }
  catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

export async function captureDuskPortfolioSnapshots(dependencies?: {
  envelope?: typeof deploymentEnvelope; capture?: typeof captureMarketSimulation;
}) {
  const before = await (dependencies?.envelope ?? deploymentEnvelope)(0,{ fresh: true }),client = await pool.connect();
  let catalog: PortfolioCatalog;
  try { await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); catalog = await readPortfolioCatalog(client); await client.query('COMMIT'); }
  catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  const maxCatalogAgeSlots = Number(process.env.DUSK_PORTFOLIO_MAX_CATALOG_AGE_SLOTS ?? 750);
  if (!Number.isSafeInteger(maxCatalogAgeSlots) || maxCatalogAgeSlots<1 || maxCatalogAgeSlots>2500
    || before.sourceSlot-catalog.accountSlot>maxCatalogAgeSlots
    || catalog.lpScanSlots.some((slot) => before.sourceSlot-slot>maxCatalogAgeSlots)
    || catalog.items.some((item) => before.sourceSlot-item.sourceSlot>maxCatalogAgeSlots)) throw new Error('Portfolio discovery scans are stale; refresh native and LP scans');
  const root = process.env.DUSK_PROTOCOL_DIR?.trim() || resolve(__dirname,'../../../protocol');
  const references = parsePriceReferences(JSON.parse(readFileSync(process.env.DUSK_PRICE_REFERENCES_FILE?.trim()
    || resolve(root,'devnet-price-references.json'),'utf8')),loadPinnedProtocol());
  const groups: MarketSimulationSnapshot[] = [];
  // Envelope reads use confirmed commitment. Its current tip cannot be used
  // as a finalized-bank floor; require the finalized catalog and deploy slots.
  const readFloor = Math.max(catalog.sourceFloor,checkedSlot(Number(before.programDataSlot)),checkedSlot(Number(before.leverageDelegateProgramDataSlot)));
  for (const market of catalog.markets) {
    const items = catalog.items.filter((item) => item.market === market);
    for (let offset=0; offset<Math.max(items.length,1); offset+=20) {
      const group = await (dependencies?.capture ?? captureMarketSimulation)(market,readFloor,items.slice(offset,offset+20).map((item) => item.address));
      if (group.deploymentIdentitySha256 !== before.deploymentIdentitySha256) throw new Error('Deployment changed during portfolio capture');
      groups.push(group);
    }
  }
  const source: PortfolioCaptureSource = { schemaVersion: 'dusk-portfolio-capture.v1',catalog,groups,references,
    observedAt: new Date().toISOString(),deploymentIdentitySha256: before.deploymentIdentitySha256,maxCatalogAgeSlots };
  if ([catalog.accountSlot,...catalog.lpScanSlots].some((slot) => coordinates(source).maxSlot-slot>maxCatalogAgeSlots))
    throw new Error('Portfolio catalog aged out during capture; refresh discovery and retry');
  const writer = await pool.connect();
  try {
    await writer.query('BEGIN'); const id = await storePortfolioCapture(writer,source); await writer.query('COMMIT');
    await writer.query('BEGIN'); const owners = await projectPortfolioCapture(writer,id); await writer.query('COMMIT');
    return { captureId: id,owners,markets: catalog.markets.length,accounts: catalog.items.length,...coordinates(source) };
  } catch (error) { await writer.query('ROLLBACK'); throw error; } finally { writer.release(); }
}

export function portfolioSampleSeconds(value: unknown): number {
  if (value === undefined) return 0;
  const seconds = typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value) ? Number(value) : value;
  if (typeof seconds !== 'number' || !Number.isSafeInteger(seconds) || (seconds !== 0 && (seconds<60 || seconds>604800)))
    throw Object.assign(new Error('Invalid portfolio history sampling interval'),{ status: 400 });
  return seconds;
}
export interface PortfolioHistoryQuery { owner: string; since?: string; until?: string; sampleSeconds?: number; limit: number; offset: number }
export async function readPortfolioHistory(client: PoolClient,options: PortfolioHistoryQuery) {
  const active = identity(),values: unknown[] = [...active,nativeKey(options.owner)];
  const filters = ['cluster=$1','program_id=$2','idl_hash=$3','protocol_revision=$4','owner=$5'];
  for (const [name,operator] of [['since','>='],['until','<=']] as const) if (options[name]) {
    const time = new Date(options[name]!).toISOString(); values.push(time); filters.push(`bucket${operator}$${values.length}`);
  }
  await assertNoPortfolioConflict(client);
  const seconds = portfolioSampleSeconds(options.sampleSeconds);
  const filtered = `filtered AS (SELECT * FROM dusk_ingestion.portfolio_checkpoints WHERE ${filters.join(' AND ')})`;
  // Return actual immutable captures, retaining the first point as a baseline.
  // Sampling changes display density only; unavailable raw points remain visible
  // in coverage so a chart cannot silently bridge a missing valuation.
  const selection = seconds === 0 ? `${filtered},selected AS (SELECT * FROM filtered)` : `${filtered},
    bucket_latest AS (SELECT DISTINCT ON (floor(extract(epoch FROM bucket)/$${values.length+1})) capture_id
      FROM filtered ORDER BY floor(extract(epoch FROM bucket)/$${values.length+1}),bucket DESC,source_max_slot DESC,capture_id DESC),
    earliest AS (SELECT capture_id FROM filtered ORDER BY bucket,source_max_slot,capture_id LIMIT 1),
    selected AS (SELECT * FROM filtered WHERE capture_id IN (SELECT capture_id FROM bucket_latest UNION SELECT capture_id FROM earliest))`;
  if (seconds !== 0) values.push(seconds);
  const summary = await client.query(`WITH ${selection} SELECT count(*)::text AS total,min(bucket) AS first_time,max(bucket) AS last_time,
    max(source_max_slot)::text AS last_slot,
    encode(sha256(convert_to(coalesce(string_agg(capture_id::text,',' ORDER BY capture_id),''),'UTF8')),'hex') AS selection_hash,
    (SELECT count(*)::text FROM filtered) AS raw_total,
    (SELECT count(*)::text FROM filtered WHERE valuations->>'quality' NOT IN ('reference-valued','empty')
      OR valuations->>'netPositionValueUsd' IS NULL OR (valuations->>'unvaluedComponents')::int>0) AS unvalued_snapshots
    FROM selected`,values);
  const rows = await client.query(`WITH ${selection} SELECT capture_id::text,owner,bucket,observed_at,source_min_slot::text,source_max_slot::text,components,coverage,valuations
    FROM selected ORDER BY bucket DESC,source_max_slot DESC,capture_id DESC
    LIMIT $${values.length+1} OFFSET $${values.length+2}`,[...values,options.limit,options.offset]);
  const pending = await client.query(`SELECT count(*)::text AS count FROM dusk_ingestion.portfolio_capture_observations o
    WHERE cluster=$1 AND program_id=$2 AND idl_hash=$3 AND protocol_revision=$4
      AND NOT EXISTS(SELECT 1 FROM dusk_ingestion.portfolio_capture_projections p WHERE p.capture_id=o.capture_id)`,active);
  const provenance = { cluster: active[0],programId: active[1],idlSha256: active[2],protocolRevision: active[3],commitment: 'finalized' as const };
  return { snapshots: rows.rows.map((row) => ({ captureId: row.capture_id,owner: row.owner,capturedAt: row.bucket.toISOString(),
    components: row.components,valuations: row.valuations,coverage: row.coverage,provenance: { ...provenance,
      sourceMinSlot: row.source_min_slot,sourceMaxSlot: row.source_max_slot,observedAt: row.observed_at.toISOString(),
      deploymentIdentitySha256: row.coverage.deploymentIdentitySha256 } })),
    pagination: { limit: options.limit,offset: options.offset,total: Number(summary.rows[0].total) },
    coverage: { available: rows.rows.length>0,historyComplete: false,atomicAcrossMarkets: false,basis: 'sampled-native-positions.v1',
      sampleSeconds: seconds,selectionHash: summary.rows[0].selection_hash as string,
      rawTotal: Number(summary.rows[0].raw_total),unvaluedSnapshots: Number(summary.rows[0].unvalued_snapshots),
      firstSnapshotAt: summary.rows[0].first_time?.toISOString() ?? null,lastSnapshotAt: summary.rows[0].last_time?.toISOString() ?? null,
      lastSourceSlot: summary.rows[0].last_slot as string | null,pendingCaptures: pending.rows[0].count as string } };
}
export async function listPortfolioHistory(options: PortfolioHistoryQuery) {
  const client = await pool.connect();
  try { await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); const result = await readPortfolioHistory(client,options);
    await client.query('COMMIT'); return result; } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}
