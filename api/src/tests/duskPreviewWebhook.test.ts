import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import type { Request, Response } from 'express';
import { previewWebhook } from '../routes/duskPreviewWebhook';
import {
  PREVIEW_PROJECT_ID,
  PREVIEW_TEAM_ID,
} from '../services/duskPreviewOrigins';
const service =
  require('../services/duskPreviewOrigins') as typeof import('../services/duskPreviewOrigins');
test('webhook requires the exact raw-body signature and never grants production or foreign-project access', async (ctx) => {
  const prior = process.env.DUSK_VERCEL_WEBHOOK_SECRET;
  const secret = 'synthetic-webhook-test-secret';
  process.env.DUSK_VERCEL_WEBHOOK_SECRET = secret;
  let records = 0;
  ctx.mock.method(service, 'recordPreviewEvent', async () => {
    records++;
  });
  const raw = Buffer.from(
    JSON.stringify({
      id: 'evt_test',
      type: 'deployment.succeeded',
      createdAt: Date.now(),
      payload: {
        team: { id: PREVIEW_TEAM_ID },
        project: { id: PREVIEW_PROJECT_ID },
        target: null,
        deployment: {
          id: 'dpl_test',
          name: 'dusk-webapp',
          url: 'dusk-test.vercel.app',
          meta: {
            githubRepoId: '1335314663',
            githubCommitOrg: 'omnipair',
            githubCommitRepo: 'dusk-webapp',
            githubCommitSha: 'a'.repeat(40),
          },
        },
      },
    }),
  );
  async function call(body: unknown, signature: unknown) {
    let status = 200;
    let result: unknown;
    const res = {
      status: (v: number) => {
        status = v;
        return res;
      },
      json: (v: unknown) => {
        result = v;
        return res;
      },
    };
    await previewWebhook(
      {
        body,
        headers: { 'x-vercel-signature': signature },
      } as unknown as Request,
      res as unknown as Response,
    );
    return { status, result };
  }
  const sign = (b: Buffer) =>
    createHmac('sha1', secret).update(b).digest('hex');
  try {
    assert.equal((await call(raw, sign(raw))).status, 200);
    assert.equal(records, 1);
    assert.equal(
      (await call(Buffer.concat([raw, Buffer.from(' ')]), sign(raw))).status,
      401,
    );
    assert.equal(
      (await call(JSON.parse(raw.toString()), sign(raw))).status,
      401,
    );
    const other = JSON.parse(raw.toString());
    other.payload.project.id = 'prj_foreign';
    const ob = Buffer.from(JSON.stringify(other));
    assert.equal((await call(ob, sign(ob))).status, 400);
    other.payload.project.id = PREVIEW_PROJECT_ID;
    other.payload.target = 'production';
    const production = Buffer.from(JSON.stringify(other));
    assert.equal((await call(production, sign(production))).status, 202);
    assert.equal(records, 1);
    delete process.env.DUSK_VERCEL_WEBHOOK_SECRET;
    assert.equal((await call(raw, sign(raw))).status, 503);
  } finally {
    if (prior === undefined) delete process.env.DUSK_VERCEL_WEBHOOK_SECRET;
    else process.env.DUSK_VERCEL_WEBHOOK_SECRET = prior;
  }
});
