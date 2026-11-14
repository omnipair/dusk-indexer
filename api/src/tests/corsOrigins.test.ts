import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import express from 'express';
import cors from 'cors';
import { corsOrigins, allowsOrigin } from '../utils/corsOrigins';

test('release browser allowlist matches exact origins for HTTP and websocket handshakes', async t => {
  const origin = corsOrigins(' https://beta.omnipair.fi,https://release.example,https://release.example ');
  const app = express();
  app.use(cors({ origin, credentials: true }));
  app.get('/health', (_req, res) => res.json({ ok: true }));
  const server = createServer(app).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  for (const candidate of ['https://beta.omnipair.fi', 'https://release.example', 'https://release.example.attacker.test', 'https://unowned.vercel.app']) {
    const response = await fetch(`http://127.0.0.1:${address.port}/health`, { headers: { Origin: candidate } });
    const allowed = ['https://beta.omnipair.fi', 'https://release.example'].includes(candidate);
    assert.equal(response.headers.get('access-control-allow-origin'), allowed ? candidate : null);
    assert.equal(allowsOrigin(origin, candidate), allowed);
  }
  assert.equal(allowsOrigin(origin, undefined), true);
  assert.equal(allowsOrigin(corsOrigins('*'), 'https://any.example'), true);
  assert.throws(() => corsOrigins('*,https://release.example'), /wildcard/);
});
