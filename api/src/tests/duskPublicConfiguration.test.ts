import test from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';

import router from '../routes/v1/duskRoutes';
import { cache } from '../utils/cache';

// Named CJS exports are looked up by the real route handlers at invocation.
const protocol = require('../config/duskProtocol') as typeof import('../config/duskProtocol');
const deployment = require('../services/duskDeploymentService') as typeof import('../services/duskDeploymentService');
const markets = require('../services/duskMarketService') as typeof import('../services/duskMarketService');

test('public deployment and configuration routes never serialize the server RPC URL', async (context) => {
  const rpcUrl = 'https://server-user:server-password@rpc.example.invalid/private-key?api-key=server-only-test-key';
  const identity = { sourceSlot: 1000, deploymentIdentitySha256: 'a'.repeat(64), programUpgradeAuthority: '11111111111111111111111111111111' };
  context.mock.method(protocol, 'duskApiConfig', () => ({ network: 'devnet', rpcUrl, primaryMarket: null }));
  context.mock.method(deployment, 'deploymentEnvelope', async () => identity);
  context.mock.method(deployment, 'withDeployment', async (data: unknown) => ({ success: true, data, deployment: identity }));
  context.mock.method(deployment, 'withDeploymentRead', async (read: (value: unknown) => Promise<{ data: unknown }>) => ({ success: true, data: (await read(identity)).data, deployment: identity }));
  context.mock.method(markets, 'discoverMarkets', async () => ({ markets: [], sourceSlot: 1000 }));
  cache.clear();
  try {
    for (const path of ['/deployment', '/config']) {
      const layer = router.stack.find((entry: any) => entry.route?.path === path);
      assert.ok(layer?.route, `${path} route is registered`);
      const handle = layer.route.stack[0].handle;
      const response = await new Promise<any>((resolve, reject) => {
        handle({} as Request, { json: resolve } as Response, reject);
      });
      assert.equal(response.success, true);
      assert.equal(response.data.network, 'devnet');
      assert.ok(response.data.protocolRevision);
      assert.ok(response.deployment.deploymentIdentitySha256);
      assert.equal(Object.prototype.hasOwnProperty.call(response.data, 'rpcUrl'), false);
      for (const secret of [rpcUrl, 'server-password', 'private-key', 'server-only-test-key'])
        assert.equal(JSON.stringify(response).includes(secret), false);
    }
  } finally {
    cache.clear();
  }
});
