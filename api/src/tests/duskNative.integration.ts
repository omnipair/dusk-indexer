/** Run against a disposable database populated by both native scan commands. */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import pool from '../config/database';
import { loadPinnedProtocol } from '../config/duskProtocol';
import { listNativeAccounts, NativeAccountKind } from '../services/duskNativeAccounts';
import { listDuskLpOwnership } from '../services/duskLpOwnership';
import { invalidateDuskReadCaches } from '../services/duskInvalidationService';
import { cache } from '../utils/cache';
import { captureDuskPortfolioSnapshots, readPortfolioCatalog } from '../services/duskPortfolioSnapshots';
import { DuskDeploymentEnvelope } from '../services/duskDeploymentService';

if (!process.env.DATABASE_URL) throw new Error('A disposable DATABASE_URL is required');
after(() => pool.end());

test('portfolio discovery decodes immutable native market bytes and covers every LP scan',async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const catalog = await readPortfolioCatalog(client);
    assert.ok(catalog.markets.length>0);
    assert.equal(catalog.lpScanIds.length,catalog.markets.length*3);
    assert.ok(catalog.items.some((item) => item.kind === 'borrow'));
    assert.ok(catalog.items.every((item) => catalog.markets.includes(item.market) && catalog.knownOwners.includes(item.owner)));
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
});

test('portfolio finalized capture does not inherit the newer confirmed envelope tip',async () => {
  const client = await pool.connect();
  let floor: number;
  try { floor = (await readPortfolioCatalog(client)).sourceFloor; } finally { client.release(); }
  let calls = 0;
  await assert.rejects(captureDuskPortfolioSnapshots({
    envelope: async () => ({ sourceSlot: floor+32,programDataSlot: String(floor-1),leverageDelegateProgramDataSlot: String(floor-2),
      deploymentIdentitySha256: 'b'.repeat(64) } as DuskDeploymentEnvelope),
    capture: async (_market,minSlot) => {
      calls++; assert.equal(minSlot,floor);
      throw new Error('Stopped after checking the finalized floor');
    },
  }),/Stopped after checking the finalized floor/);
  assert.equal(calls,1);
});

test('native domains return full current identity, raw fields and stable owner-filtered pagination', async () => {
  const pin = loadPinnedProtocol();
  for (const kind of ['markets','borrow','leverage','yield','orders'] as NativeAccountKind[]) {
    const result = await listNativeAccounts({ cluster: pin.cluster, kind, limit: 500, offset: 0 });
    const program = kind === 'orders' ? pin.leverageDelegate : pin.dusk;
    assert.equal(result.coverage.idlSha256, program.idlCanonicalSha256);
    assert.equal(result.coverage.protocolRevision, pin.revision);
    assert.equal(result.accounts.length, result.pagination.total);
    for (const row of result.accounts) {
      assert.equal(row.provenance.programId, program.programId);
      assert.ok(BigInt(row.provenance.sourceSlot) <= BigInt(result.coverage.sourceSlot));
      assert.ok(row.provenance.blockhash.length > 0);
    }
    const first = result.accounts.find((row) => typeof row.fields.owner === 'string');
    if (first) {
      const filtered = await listNativeAccounts({ cluster: pin.cluster, kind, owner: first.fields.owner, limit: 500, offset: 0 });
      assert.ok(filtered.accounts.length > 0);
      assert.ok(filtered.accounts.every((row) => row.fields.owner === first.fields.owner));
    }
  }
  await assert.rejects(listNativeAccounts({ cluster: 'wrong-cluster', kind: 'markets', limit: 1, offset: 0 }), /cluster/);
});

test('LP ownership adapter agrees with complete persisted supply and excludes the previous owner', async () => {
  const result = await listDuskLpOwnership({ limit: 500, offset: 0 });
  assert.ok(result.coverage.scans.length > 0);
  assert.equal(result.accounts.length, result.pagination.total);
  for (const row of result.accounts) assert.match(row.amount, /^\d+$/);
  const mismatches = await pool.query(`SELECT s.scan_id FROM dusk_ingestion.latest_lp_token_scans s
    LEFT JOIN dusk_ingestion.lp_token_observations o USING(scan_id) GROUP BY s.scan_id,s.mint_supply HAVING COALESCE(sum(o.amount),0)<>s.mint_supply`);
  assert.equal(mismatches.rowCount, 0);
  if (result.accounts[0]) {
    const owner = result.accounts[0].owner;
    const filtered = await listDuskLpOwnership({ owner, limit: 500, offset: 0 });
    assert.ok(filtered.accounts.length > 0);
    assert.ok(filtered.accounts.every((row) => row.owner === owner));
  }
});

test('notifications invalidate only the active identity and leave immutable block metadata cached', () => {
  const pin = loadPinnedProtocol();
  cache.set('dusk:market_health:test', 'old', 10_000);
  cache.set('dusk:block_time:test', 123, 10_000);
  const notice = { cluster: pin.cluster, programId: pin.dusk.programId, idlHash: pin.dusk.idlCanonicalSha256, protocolRevision: pin.revision };
  invalidateDuskReadCaches(JSON.stringify({ ...notice, protocolRevision: 'wrong' }));
  assert.equal(cache.get('dusk:market_health:test'), 'old');
  invalidateDuskReadCaches(JSON.stringify(notice));
  assert.equal(cache.get('dusk:market_health:test'), null);
  assert.equal(cache.get('dusk:block_time:test'), 123);
});
