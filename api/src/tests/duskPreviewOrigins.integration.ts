/** Disposable PostgreSQL only. All event and origin mutations roll back. */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import pool from '../config/database';
import {
  parsePreviewEvent,
  PREVIEW_PROJECT_ID,
  PREVIEW_TEAM_ID,
  readPreviewOrigins,
  recordPreviewEventOnClient,
} from '../services/duskPreviewOrigins';
if (
  process.env.DUSK_ALLOW_DISPOSABLE_DB_TESTS !== 'true' ||
  !process.env.DATABASE_URL
)
  throw new Error('Use a disposable database');
after(() => pool.end());
test('origin grants are ready-only, idempotent, order-independent and permanently revoked on cleanup', async () => {
  const client = await pool.connect();
  await client.query('BEGIN');
  try {
    await client.query(
      readFileSync(
        resolve(
          __dirname,
          '../../../database/migrations/062_dusk_browser_preview_origins.sql',
        ),
        'utf8',
      ),
    );
    const deploymentId = 'dpl_' + randomUUID().replace(/-/g, '');
    const host = 'preview-' + randomUUID() + '.vercel.app';
    const alias = 'branch-' + randomUUID() + '.vercel.app';
    const now = Date.now();
    function event(type: string, time: number, aliases: string[] = []) {
      return parsePreviewEvent(
        Buffer.from(
          JSON.stringify({
            id: 'evt_' + randomUUID(),
            type,
            createdAt: time,
            payload: {
              team: { id: PREVIEW_TEAM_ID },
              project: { id: PREVIEW_PROJECT_ID },
              target: null,
              alias: aliases,
              deployment: {
                id: deploymentId,
                name: 'dusk-webapp',
                url: host,
                meta: {
                  githubRepoId: '1335314663',
                  githubCommitOrg: 'omnipair',
                  githubCommitRepo: 'dusk-webapp',
                  githubCommitSha: 'a'.repeat(40),
                },
              },
            },
          }),
        ),
        now,
      )!;
    }
    const created = event('deployment.created', now - 1000, [alias]);
    await recordPreviewEventOnClient(client, created);
    assert.ok(!(await readPreviewOrigins(client)).includes('https://' + alias));
    await recordPreviewEventOnClient(
      client,
      event('deployment.succeeded', now),
    );
    assert.ok((await readPreviewOrigins(client)).includes('https://' + alias));
    await recordPreviewEventOnClient(client, created);
    assert.equal(
      (
        await client.query(
          'SELECT count(*)::int AS n FROM dusk_ingestion.browser_preview_events WHERE deployment_id=$1',
          [deploymentId],
        )
      ).rows[0].n,
      2,
    );
    await assert.rejects(
      recordPreviewEventOnClient(client, {
        ...created,
        bodySha256: 'b'.repeat(64),
      }),
      /identity conflict/,
    );
    await recordPreviewEventOnClient(
      client,
      event('deployment.cleanup', now + 100),
    );
    await recordPreviewEventOnClient(
      client,
      event('deployment.succeeded', now + 200),
    );
    assert.ok(!(await readPreviewOrigins(client)).includes('https://' + alias));
    const secondId = 'dpl_' + randomUUID().replace(/-/g, '');
    await recordPreviewEventOnClient(client, {
      ...event('deployment.succeeded', now),
      deploymentId: secondId,
    });
    const late = {
      ...event('deployment.created', now - 500, [alias]),
      deploymentId: secondId,
    };
    await recordPreviewEventOnClient(client, late);
    assert.ok(
      (await readPreviewOrigins(client)).includes('https://' + alias),
      'late created event supplies aliases to an already-ready deployment',
    );
    await recordPreviewEventOnClient(
      client,
      event('deployment.cleanup', now + 300),
    );
    assert.ok(
      (await readPreviewOrigins(client)).includes('https://' + alias),
      'cleaning an old deployment does not revoke the replacement',
    );
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});
