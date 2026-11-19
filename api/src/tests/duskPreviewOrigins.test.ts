import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  exactVercelOrigin,
  parsePreviewEvent,
  PREVIEW_PROJECT_ID,
  PREVIEW_TEAM_ID,
  verifyVercelSignature,
  verifiedBootstrapEvents,
} from '../services/duskPreviewOrigins';
const now = 1795140000000;
function event() {
  return {
    id: 'evt_123',
    type: 'deployment.created',
    createdAt: now,
    payload: {
      team: { id: PREVIEW_TEAM_ID },
      project: { id: PREVIEW_PROJECT_ID },
      target: null,
      alias: ['dusk-webapp-git-feature-omnipair.vercel.app'],
      deployment: {
        id: 'dpl_123',
        name: 'dusk-webapp',
        url: 'dusk-webapp-unique-omnipair.vercel.app',
        meta: {
          githubRepoId: '1335314663',
          githubCommitOrg: 'omnipair',
          githubCommitRepo: 'dusk-webapp',
          githubCommitSha: 'a'.repeat(40),
        },
      },
    },
  };
}
test('only authenticated, owned ready deployments can admit exact origins', () => {
  const e = event(),
    body = Buffer.from(JSON.stringify(e)),
    secret = 'synthetic-unit-webhook-secret';
  const signature = createHmac('sha1', secret).update(body).digest('hex');
  assert.equal(verifyVercelSignature(body, signature, secret), true);
  for (const sig of [
    undefined,
    '',
    'f'.repeat(40),
    signature.toUpperCase(),
    '0'.repeat(39),
  ])
    assert.equal(verifyVercelSignature(body, sig, secret), false);
  assert.equal(
    verifyVercelSignature(
      Buffer.concat([body, Buffer.from(' ')]),
      signature,
      secret,
    ),
    false,
  );
  assert.equal(verifyVercelSignature(body, signature, ''), false);
  assert.deepEqual(parsePreviewEvent(body, now)?.origins, [
    'https://dusk-webapp-unique-omnipair.vercel.app',
    'https://dusk-webapp-git-feature-omnipair.vercel.app',
  ]);
});
test('Vercel hostname spelling alone grants no ownership', () => {
  for (const mutate of [
    (e: any) => (e.payload.team.id = 'team_attacker'),
    (e: any) => (e.payload.project.id = 'prj_attacker'),
    (e: any) => (e.payload.deployment.meta.githubRepoId = '1'),
    (e: any) => (e.payload.deployment.name = 'another-project'),
    (e: any) => (e.payload.deployment.meta.githubCommitSha = 'missing'),
  ]) {
    const e = event();
    mutate(e);
    assert.throws(() => parsePreviewEvent(Buffer.from(JSON.stringify(e)), now));
  }
  const e = event();
  e.payload.target = 'production' as any;
  assert.equal(parsePreviewEvent(Buffer.from(JSON.stringify(e)), now), null);
});
test('malformed origins, stale events, alias overflow and future time are rejected', () => {
  for (const value of [
    'http://preview.vercel.app',
    'https://preview.vercel.app:444',
    'https://preview.vercel.app/path',
    'https://user@preview.vercel.app',
    'https://preview.vercel.app.evil',
    'null',
    'https://*.vercel.app',
  ])
    assert.equal(exactVercelOrigin(value), null, value);
  for (const mutate of [
    (e: any) => (e.createdAt = now - 27 * 3600000),
    (e: any) => (e.createdAt = now + 600000),
    (e: any) => (e.payload.alias = Array(101).fill('a.vercel.app')),
    (e: any) => (e.payload.deployment.url = 'https://foreign.example'),
  ]) {
    const e = event();
    mutate(e);
    assert.throws(() => parsePreviewEvent(Buffer.from(JSON.stringify(e)), now));
  }
  const e = event();
  e.payload.alias.push(
    'foreign.example',
    'preview.vercel.app.evil',
    'beta.omnipair.fi',
  );
  assert.equal(
    parsePreviewEvent(Buffer.from(JSON.stringify(e)), now)!.origins.length,
    2,
  );
});

test('cleanup uses the documented nested target and aliases', () => {
  const e: any = event();
  e.type = 'deployment.cleanup';
  e.payload.deployment.target = null;
  e.payload.deployment.alias = e.payload.alias;
  delete e.payload.target;
  delete e.payload.alias;
  assert.equal(
    parsePreviewEvent(Buffer.from(JSON.stringify(e)), now)?.type,
    'deployment.cleanup',
  );
});

test('historic verified API bootstrap has stable valid event IDs and real content hashes', () => {
  const p = event().payload;
  const d = {
    ...p.deployment,
    createdAt: now - 30 * 24 * 3600000,
    readyState: 'READY',
    target: null,
    projectId: PREVIEW_PROJECT_ID,
    ownerId: PREVIEW_TEAM_ID,
    team: p.team,
    alias: p.alias,
  };
  const a = verifiedBootstrapEvents(d),
    b = verifiedBootstrapEvents({ ...d, alias: [...d.alias].reverse() });
  assert.equal(a.length, 2);
  assert.deepEqual(a, b);
  for (const e of a) {
    assert.match(e.id, /^[a-zA-Z0-9_:-]{1,200}$/);
    assert.match(e.bodySha256, /^[a-f0-9]{64}$/);
  }
  assert.throws(() => verifiedBootstrapEvents({ ...d, ownerId: 'foreign' }));
  assert.deepEqual(verifiedBootstrapEvents({ ...d, target: 'production' }), []);
});

test('registry caching bounds refreshes and clears grants after a read failure', async (ctx) => {
  const { default: pool } = await import('../config/database');
  const { allowsPreviewOrigin, invalidatePreviewOrigins } =
    await import('../services/duskPreviewOrigins');
  const saved = process.env.DUSK_VERCEL_WEBHOOK_SECRET;
  process.env.DUSK_VERCEL_WEBHOOK_SECRET = 'synthetic-cache-secret';
  let clock = now,
    reads = 0,
    fail = false;
  ctx.mock.method(Date, 'now', () => clock);
  ctx.mock.method(pool, 'query', async () => {
    reads++;
    if (fail) throw new Error('synthetic database outage');
    return { rows: [{ origin: 'https://owned.vercel.app' }] };
  });
  try {
    invalidatePreviewOrigins();
    assert.equal(await allowsPreviewOrigin('https://owned.vercel.app'), true);
    assert.equal(await allowsPreviewOrigin('https://owned.vercel.app'), true);
    assert.equal(
      await allowsPreviewOrigin('https://foreign.vercel.app'),
      false,
    );
    assert.equal(reads, 1);
    clock += 11000;
    fail = true;
    assert.equal(await allowsPreviewOrigin('https://owned.vercel.app'), false);
    assert.equal(await allowsPreviewOrigin('https://owned.vercel.app'), false);
    assert.equal(
      reads,
      2,
      'outages cannot trigger one query per browser request',
    );
    fail = false;
    invalidatePreviewOrigins();
    assert.equal(await allowsPreviewOrigin('https://owned.vercel.app'), true);
    assert.equal(reads, 3, 'a new committed grant invalidates the cache');
    delete process.env.DUSK_VERCEL_WEBHOOK_SECRET;
    assert.equal(await allowsPreviewOrigin('https://owned.vercel.app'), false);
  } finally {
    if (saved === undefined) delete process.env.DUSK_VERCEL_WEBHOOK_SECRET;
    else process.env.DUSK_VERCEL_WEBHOOK_SECRET = saved;
    invalidatePreviewOrigins();
    await pool.end();
  }
});
