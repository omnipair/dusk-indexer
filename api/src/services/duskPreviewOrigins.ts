import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { PoolClient } from 'pg';
import pool from '../config/database';

export const PREVIEW_PROJECT_ID = 'prj_ztwzUn81e0xHqLa2NjoHbnqXy0EF';
export const PREVIEW_TEAM_ID = 'team_mUKFDc1HjGHQuYhtdIuDIh0x';
export const PREVIEW_REPOSITORY_ID = '1335314663';
export const PREVIEW_SCHEMA = 'dusk-owned-preview-origins.v1';
export interface PreviewEvent {
  id: string;
  type: 'deployment.created' | 'deployment.succeeded' | 'deployment.cleanup';
  createdAt: number;
  deploymentId: string;
  commit: string;
  origins: string[];
  bodySha256: string;
}

/** Hostname spelling is validation, never evidence of project ownership. */
export function exactVercelOrigin(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(
      value.startsWith('https://') ? value : `https://${value}`,
    );
    return url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.port &&
      url.pathname === '/' &&
      !url.search &&
      !url.hash &&
      /^[a-z0-9][a-z0-9-]{0,62}\.vercel\.app$/.test(url.hostname)
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

export function verifyVercelSignature(
  body: Buffer,
  signature: unknown,
  secret: string,
): boolean {
  if (
    secret.length < 16 ||
    typeof signature !== 'string' ||
    !/^[a-f0-9]{40}$/.test(signature)
  )
    return false;
  const expected = createHmac('sha1', secret).update(body).digest();
  return timingSafeEqual(expected, Buffer.from(signature, 'hex'));
}

export function parsePreviewEvent(
  body: Buffer,
  now = Date.now(),
): PreviewEvent | null {
  const event = JSON.parse(body.toString('utf8'));
  if (
    ![
      'deployment.created',
      'deployment.succeeded',
      'deployment.cleanup',
    ].includes(event.type)
  )
    return null;
  const p = event.payload,
    d = p?.deployment,
    meta = d?.meta;
  if (
    p?.team?.id !== PREVIEW_TEAM_ID ||
    p?.project?.id !== PREVIEW_PROJECT_ID ||
    d?.name !== 'dusk-webapp'
  )
    throw new Error('Unrecognized preview owner');
  const target = Object.prototype.hasOwnProperty.call(p, 'target')
    ? p.target
    : d.target;
  if (target === 'production' || target === 'staging') return null;
  if (target !== null && target !== 'preview')
    throw new Error('Invalid preview target');
  if (
    !meta ||
    String(meta.githubRepoId) !== PREVIEW_REPOSITORY_ID ||
    meta.githubCommitOrg !== 'omnipair' ||
    meta.githubCommitRepo !== 'dusk-webapp' ||
    !/^[a-f0-9]{40}$/.test(meta.githubCommitSha)
  )
    throw new Error('Unrecognized preview repository');
  if (
    typeof event.id !== 'string' ||
    !/^[a-zA-Z0-9_:-]{1,200}$/.test(event.id) ||
    typeof d.id !== 'string' ||
    !/^dpl_[a-zA-Z0-9]{1,100}$/.test(d.id) ||
    !Number.isSafeInteger(event.createdAt) ||
    event.createdAt < now - 26 * 60 * 60 * 1000 ||
    event.createdAt > now + 5 * 60 * 1000
  )
    throw new Error('Invalid preview event identity or time');
  const immutable = exactVercelOrigin(d.url);
  if (!immutable) throw new Error('Invalid preview deployment origin');
  const aliases = p.alias ?? d.alias ?? [];
  if (
    !Array.isArray(aliases) ||
    aliases.length > 100 ||
    aliases.some((a) => typeof a !== 'string')
  )
    throw new Error('Invalid preview aliases');
  const origins = [
    ...new Set([
      immutable,
      ...aliases.map(exactVercelOrigin).filter((v): v is string => v !== null),
    ]),
  ];
  return {
    id: event.id,
    type: event.type,
    createdAt: event.createdAt,
    deploymentId: d.id,
    commit: meta.githubCommitSha,
    origins,
    bodySha256: createHash('sha256').update(body).digest('hex'),
  };
}

/** Explicit operator bootstrap from authenticated Vercel API metadata, never a browser request. */
export function verifiedBootstrapEvents(d: any): PreviewEvent[] {
  if (
    d.projectId !== PREVIEW_PROJECT_ID ||
    d.ownerId !== PREVIEW_TEAM_ID ||
    d.team?.id !== PREVIEW_TEAM_ID
  )
    throw new Error('Unrecognized deployment owner');
  if (d.readyState !== 'READY' || ![null, 'preview'].includes(d.target))
    return [];
  if (!Number.isSafeInteger(d.createdAt) || d.createdAt <= 0)
    throw new Error('Missing deployment creation time');
  const meta = Object.fromEntries(
    [
      'githubRepoId',
      'githubCommitOrg',
      'githubCommitRepo',
      'githubCommitSha',
    ].map((k) => [k, d.meta?.[k]]),
  );
  return ['deployment.created', 'deployment.succeeded'].map((type) => {
    const payload = {
      team: { id: d.ownerId },
      project: { id: d.projectId },
      target: d.target,
      alias: [...(d.alias ?? [])].sort(),
      deployment: { id: d.id, name: d.name, url: d.url, meta },
    };
    const fingerprint = createHash('sha256')
      .update(JSON.stringify({ type, payload }))
      .digest('hex')
      .slice(0, 16);
    const raw = Buffer.from(
      JSON.stringify({
        id: `bootstrap:${d.id}:${fingerprint}:${type.replace('.', '-')}`,
        type,
        createdAt: d.createdAt,
        payload,
      }),
    );
    return parsePreviewEvent(raw, d.createdAt)!;
  });
}

/** Call inside a transaction: delivery deduplication and origin changes commit together. */
export async function recordPreviewEventOnClient(
  client: Pick<PoolClient, 'query'>,
  e: PreviewEvent,
  source = 'webhook',
): Promise<void> {
  const receipt = await client.query<{ body_sha256: string }>(
    `INSERT INTO dusk_ingestion.browser_preview_events
    (event_id,body_sha256,deployment_id,event_type,event_time_ms,source)
    VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (event_id) DO NOTHING RETURNING body_sha256`,
    [e.id, e.bodySha256, e.deploymentId, e.type, e.createdAt, source],
  );
  if (!receipt.rowCount) {
    const old = await client.query<{ body_sha256: string }>(
      'SELECT body_sha256 FROM dusk_ingestion.browser_preview_events WHERE event_id=$1',
      [e.id],
    );
    if (old.rows[0]?.body_sha256 !== e.bodySha256)
      throw new Error('Preview event identity conflict');
    return;
  }
  await client.query(
    `INSERT INTO dusk_ingestion.browser_preview_deployments
    (deployment_id,project_id,team_id,repository_id,git_commit,origins,created_event_ms,ready_event_ms,cleanup_event_ms)
    VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9)
    ON CONFLICT (deployment_id) DO UPDATE SET
      origins=(SELECT jsonb_agg(DISTINCT value) FROM jsonb_array_elements(dusk_ingestion.browser_preview_deployments.origins || EXCLUDED.origins)),
      created_event_ms=GREATEST(dusk_ingestion.browser_preview_deployments.created_event_ms,EXCLUDED.created_event_ms),
      ready_event_ms=GREATEST(dusk_ingestion.browser_preview_deployments.ready_event_ms,EXCLUDED.ready_event_ms),
      cleanup_event_ms=GREATEST(dusk_ingestion.browser_preview_deployments.cleanup_event_ms,EXCLUDED.cleanup_event_ms),updated_at=now()`,
    [
      e.deploymentId,
      PREVIEW_PROJECT_ID,
      PREVIEW_TEAM_ID,
      PREVIEW_REPOSITORY_ID,
      e.commit,
      JSON.stringify(e.origins),
      e.type === 'deployment.created' ? e.createdAt : 0,
      e.type === 'deployment.succeeded' ? e.createdAt : 0,
      e.type === 'deployment.cleanup' ? e.createdAt : 0,
    ],
  );
}

export async function recordPreviewEvent(
  e: PreviewEvent,
  source = 'webhook',
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await recordPreviewEventOnClient(client, e, source);
    await client.query('COMMIT');
    invalidatePreviewOrigins();
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function readPreviewOrigins(
  client: Pick<PoolClient, 'query'> = pool,
): Promise<string[]> {
  const result = await client.query<{ origin: string }>(
    `SELECT DISTINCT jsonb_array_elements_text(origins) AS origin
    FROM dusk_ingestion.browser_preview_deployments WHERE project_id=$1 AND team_id=$2 AND repository_id=$3
      AND ready_event_ms>0 AND cleanup_event_ms=0 ORDER BY origin LIMIT 10001`,
    [PREVIEW_PROJECT_ID, PREVIEW_TEAM_ID, PREVIEW_REPOSITORY_ID],
  );
  if (result.rows.length > 10000)
    throw new Error('Preview registry capacity exceeded');
  return result.rows
    .map((r) => r.origin)
    .filter((v): v is string => exactVercelOrigin(v) === v);
}

let cached = new Set<string>(),
  loadedAt = 0,
  lastAttempt = 0,
  loading: Promise<void> | null = null;
export function invalidatePreviewOrigins(): void {
  loadedAt = 0;
  lastAttempt = 0;
}
export async function allowsPreviewOrigin(origin: string): Promise<boolean> {
  if (
    !process.env.DUSK_VERCEL_WEBHOOK_SECRET ||
    exactVercelOrigin(origin) !== origin
  )
    return false;
  const age = Date.now() - loadedAt;
  if (cached.has(origin) && age < 10000) return true;
  if (!loading && Date.now() - lastAttempt >= 1000) {
    lastAttempt = Date.now();
    loading = readPreviewOrigins()
      .then((origins) => {
        cached = new Set(origins);
        loadedAt = Date.now();
      })
      .catch(() => {
        cached.clear();
        loadedAt = 0;
      })
      .finally(() => {
        loading = null;
      });
  }
  if (loading) await loading;
  return Date.now() - loadedAt < 10000 && cached.has(origin);
}
