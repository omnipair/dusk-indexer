import test from 'node:test';
import assert from 'node:assert/strict';
import { Connection } from '@solana/web3.js';
import { discoverMarkets } from '../services/duskMarketService';

const protocol = require('../config/duskProtocol') as typeof import('../config/duskProtocol');

test('market discovery never answers below a bank it has already served', async (context) => {
  context.mock.method(protocol, 'duskApiConfig', () => ({ network: 'devnet', rpcUrl: 'http://localhost:1', buildRevision: 'test', primaryMarket: null }));
  const floors: Array<number | undefined> = [];
  let lagging = true;
  context.mock.method(Connection.prototype, 'getProgramAccounts', async (_program: unknown, config: { minContextSlot?: number }) => {
    floors.push(config.minContextSlot);
    if (config.minContextSlot !== undefined && lagging) {
      lagging = false;
      throw new Error('failed to get accounts owned by program: Minimum context slot has not been reached');
    }
    return { context: { slot: config.minContextSlot === undefined ? 600_000_010 : 600_000_012 }, value: [] };
  });

  assert.equal((await discoverMarkets()).sourceSlot, 600_000_010);
  // The next read is floored at the served bank; a lagging replica is retried.
  assert.equal((await discoverMarkets()).sourceSlot, 600_000_012);
  assert.deepEqual(floors, [undefined, 600_000_010, 600_000_010]);
});
