import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { createHmac, randomBytes } from 'node:crypto';
import pool from '../config/database';
import { perfMetrics } from '../utils/perfMetrics';
import {
  PREVIEW_PROJECT_ID,
  PREVIEW_TEAM_ID,
} from '../services/duskPreviewOrigins';
import { createDuskSocketServer } from '../services/duskSocket';
const service =
  require('../services/duskPreviewOrigins') as typeof import('../services/duskPreviewOrigins');
process.env.CORS_ORIGIN = 'https://beta.omnipair.fi';
const app = require('../app').default;
after(async () => {
  perfMetrics.stopReporting();
  await pool.end();
});

test('real HTTP middleware preserves signed raw bytes and admits only verified preview origins', async (ctx) => {
  const secret = 'synthetic-http-webhook-secret';
  process.env.DUSK_VERCEL_WEBHOOK_SECRET = secret;
  let delivered = 0;
  ctx.mock.method(service, 'recordPreviewEvent', async () => {
    delivered++;
  });
  ctx.mock.method(
    service,
    'allowsPreviewOrigin',
    async (origin: string) => origin === 'https://owned.vercel.app',
  );
  ctx.mock.method(service, 'readPreviewOrigins', async () => [
    'https://owned.vercel.app',
  ]);
  const server = createServer(app).listen(0, '127.0.0.1');
  await once(server, 'listening');
  ctx.after(() => {
    server.closeAllConnections();
    server.close();
    delete process.env.DUSK_VERCEL_WEBHOOK_SECRET;
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const url = `http://127.0.0.1:${address.port}`;
  const body = Buffer.from(
    JSON.stringify(
      {
        id: 'evt_http',
        type: 'deployment.succeeded',
        createdAt: Date.now(),
        payload: {
          team: { id: PREVIEW_TEAM_ID },
          project: { id: PREVIEW_PROJECT_ID },
          target: null,
          deployment: {
            id: 'dpl_http',
            url: 'owned.vercel.app',
            name: 'dusk-webapp',
            meta: {
              githubRepoId: '1335314663',
              githubCommitOrg: 'omnipair',
              githubCommitRepo: 'dusk-webapp',
              githubCommitSha: 'a'.repeat(40),
            },
          },
        },
      },
      null,
      2,
    ) + '\n',
  );
  const signature = createHmac('sha1', secret).update(body).digest('hex');
  const response = await fetch(url + '/internal/vercel/previews', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-vercel-signature': signature,
    },
    body,
  });
  assert.equal(response.status, 200);
  assert.equal(delivered, 1);
  const altered = await fetch(url + '/internal/vercel/previews', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-vercel-signature': signature,
    },
    body: Buffer.concat([body, Buffer.from(' ')]),
  });
  assert.equal(altered.status, 401);
  assert.equal(delivered, 1);
  const registry = await fetch(url + '/internal/browser-origins');
  assert.equal(registry.status, 200);
  const publicBody = await registry.text();
  assert.ok(!publicBody.includes(secret));
  for (const origin of [
    'https://beta.omnipair.fi',
    'https://owned.vercel.app',
    'https://foreign.vercel.app',
  ]) {
    const r = await fetch(url + '/cors-test-unmatched-route', {
      headers: { Origin: origin },
    });
    assert.equal(
      r.headers.get('access-control-allow-origin'),
      origin === 'https://foreign.vercel.app' ? null : origin,
    );
  }
});

test('Socket.IO upgrade uses the same verified-origin decision as REST', async (ctx) => {
  ctx.mock.method(
    service,
    'allowsPreviewOrigin',
    async (origin: string) => origin === 'https://owned.vercel.app',
  );
  const server = createServer();
  const io = createDuskSocketServer(
    server,
    {} as any,
    'https://beta.omnipair.fi',
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  ctx.after(() => {
    io.close();
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  async function handshake(origin: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const req = request({
        hostname: '127.0.0.1',
        port: (address as any).port,
        path: '/socket.io/?EIO=4&transport=websocket',
        headers: {
          Origin: origin,
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Version': '13',
          'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
        },
      });
      req.setTimeout(2000, () => req.destroy(new Error('Handshake timeout')));
      req.on('error', reject);
      req.on('upgrade', (res, socket) => {
        socket.destroy();
        resolve(res.statusCode!);
      });
      req.on('response', (res) => {
        res.resume();
        resolve(res.statusCode!);
      });
      req.end();
    });
  }
  assert.equal(await handshake('https://owned.vercel.app'), 101);
  // Engine.IO rejects forbidden websocket upgrades with HTTP 400.
  assert.equal(await handshake('https://foreign.vercel.app'), 400);
  assert.equal(await handshake('https://beta.omnipair.fi'), 101);
});
