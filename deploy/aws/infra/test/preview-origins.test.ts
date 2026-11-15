import { strict as assert } from 'node:assert';
import { test } from 'node:test';
// The operator helper is plain JavaScript so it also runs without a TS loader.
// @ts-expect-error No declaration file for the operational script.
import { verifiedPreviewOrigins } from '../scripts/register-preview.mjs';

const origin = 'https://dusk-webapp-git-feat-test-omnipair.vercel.app';
const deployment = {
  projectId: 'prj_ztwzUn81e0xHqLa2NjoHbnqXy0EF',
  ownerId: 'team_mUKFDc1HjGHQuYhtdIuDIh0x',
  team: { id: 'team_mUKFDc1HjGHQuYhtdIuDIh0x' },
  name: 'dusk-webapp', readyState: 'READY', target: null,
  url: 'dusk-webapp-unique-omnipair.vercel.app', alias: [new URL(origin).host],
  meta: { githubRepoId: '1335314663', githubCommitOrg: 'omnipair', githubCommitRepo: 'dusk-webapp',
    githubCommitRef: 'feat/test', githubCommitSha: 'a'.repeat(40) },
};

test('registration includes only the requested verified alias and its immutable deployment', () => {
  assert.deepEqual(verifiedPreviewOrigins(origin, deployment), [origin, `https://${deployment.url}`]);
  assert.deepEqual(verifiedPreviewOrigins(`https://${deployment.url}`, deployment), [`https://${deployment.url}`]);
});

test('a familiar Vercel hostname cannot substitute for project, team or repository ownership', () => {
  for (const patch of [{ projectId: 'other' }, { ownerId: 'other' }, { team: { id: 'other' } },
    { meta: { ...deployment.meta, githubRepoId: 'other' } },
    { meta: { ...deployment.meta, githubCommitRepo: 'other' } }])
    assert.throws(() => verifiedPreviewOrigins(origin, { ...deployment, ...patch }), /owned/);
  assert.throws(() => verifiedPreviewOrigins('https://unrelated-omnipair.vercel.app', deployment), /belong/);
});

test('registration refuses production, unfinished deployments and wildcard or non-origin inputs', () => {
  for (const patch of [{ target: 'production' }, { readyState: 'BUILDING' },
    { meta: { ...deployment.meta, githubCommitSha: '' } }])
    assert.throws(() => verifiedPreviewOrigins(origin, { ...deployment, ...patch }), /ready Git preview/);
  for (const value of ['https://*.vercel.app', `${origin}/path`, origin.replace('https:', 'http:')])
    assert.throws(() => verifiedPreviewOrigins(value, deployment), /exact HTTPS/);
});
