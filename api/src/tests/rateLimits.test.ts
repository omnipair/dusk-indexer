import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import express, { type Request } from 'express';
import { apiRateLimitKey, createApiRateLimits } from '../middleware/rateLimits';

test('identity checks have a separate bounded budget from native data reads', async () => {
  const app = express();
  app.use(...createApiRateLimits({ RATE_LIMIT_MAX: '2', RATE_LIMIT_IDENTITY_MAX: '4' }));
  app.use((_req, res) => res.json({ ok: true }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    for (let i = 0; i < 4; i++) {
      const result = await fetch(`${base}/api/dusk/v1/deployment`);
      assert.equal(result.status, 200);
      await result.text();
    }
    const blocked = await fetch(`${base}/api/dusk/v1/deployment`);
    assert.equal(blocked.status, 429);
    assert.ok(blocked.headers.get('retry-after'));
    await blocked.text();
    // Changing a client-supplied CF header must not bypass the ordinary limit.
    for (let i = 0; i < 3; i++) {
      const result = await fetch(`${base}/api/dusk/v1/markets/state`, {
        headers: { 'cf-connecting-ip': `192.0.2.${i + 1}` },
      });
      assert.equal(result.status, i < 2 ? 200 : 429);
      await result.text();
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('IPv6 addresses within the default client subnet share a budget', () => {
  const key = (ip: string) => apiRateLimitKey({ ip } as Request);
  assert.equal(key('2001:db8:abcd:1200::1'), key('2001:db8:abcd:12ff::2'));
  assert.notEqual(key('192.0.2.1'), key('192.0.2.2'));
});

test('invalid request budgets fail startup', () => {
  for (const value of ['0', '-1', 'NaN', '10extra', '1.5']) {
    assert.throws(() => createApiRateLimits({ RATE_LIMIT_MAX: value }));
    assert.throws(() => createApiRateLimits({ RATE_LIMIT_IDENTITY_MAX: value }));
  }
});
