/** Disposable PostgreSQL only: every fixture rolls back. Discovery for the
 * live reads comes from streamed events. */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { PoolClient } from 'pg';
import pool from '../config/database';
import { readStreamedBorrowPositions } from '../services/duskBorrowValuation';
import { readStreamedHlpBalances } from '../services/duskHlpPositions';
import { fixtureMarket, key, streamedEvent, streamedIdentity, streamedMarket, streamedRelease } from './duskStreamedFixtures';

if (process.env.DUSK_ALLOW_DISPOSABLE_DB_TESTS !== 'true' || !process.env.DATABASE_URL)
  throw new Error('Set DUSK_ALLOW_DISPOSABLE_DB_TESTS=true and a disposable DATABASE_URL');
after(() => pool.end());

const { market, baseHlp } = fixtureMarket;
const owner = key(201),
  other = key(202);

async function transaction(work: (client: PoolClient) => Promise<void>) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO dusk_ingestion.protocol_identities(cluster,program_id,idl_hash,protocol_revision)
      VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`, streamedIdentity);
    await streamedRelease(client, { slot: 900_500_000, time: new Date(Date.now() - 1000) });
    await work(client);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

test('borrow discovery keeps open snapshots, per owner or with debt, dated by the stream', () => transaction(async (client) => {
  const snapshot = (position: string, holder: string, shares: string, closed = false) =>
    streamedEvent(client, 'BorrowPositionUpdated', { market, position, owner: holder, base_collateral: '10', quote_collateral: '0',
      fixed_base_shares: '0', fixed_quote_shares: shares, closed });
  await snapshot(key(211), owner, '5');
  await snapshot(key(212), owner, '0');
  await snapshot(key(213), other, '9');
  await snapshot(key(214), owner, '7');
  await snapshot(key(214), owner, '0', true);
  const mine = await readStreamedBorrowPositions({ owner }, client);
  assert.deepEqual(mine.positions.map((row) => row.address).sort(), [key(211), key(212)].sort());
  assert.equal(mine.sourceSlot, 900_500_000);
  const indebted = await readStreamedBorrowPositions({ withDebt: true }, client);
  assert.deepEqual(indebted.positions.map((row) => `${row.address}:${row.owner}`).sort(), [`${key(211)}:${owner}`, `${key(213)}:${other}`].sort());
}));

test('hLP holdings are the owner\'s non-zero hLP balances by vault side', () => transaction(async (client) => {
  await streamedMarket(client);
  await streamedEvent(client, 'LiquidityAdded', { market, owner, ylp_amount: '1000' });
  await streamedEvent(client, 'HlpOpened', { market, owner, asset_side: '0', hlp_amount: '40', ylp_amount: '1' });
  await streamedEvent(client, 'HlpOpened', { market, owner, asset_side: '1', hlp_amount: '15', ylp_amount: '1' });
  await streamedEvent(client, 'HlpClosed', { market, owner, asset_side: '1', hlp_amount: '15', ylp_amount: '1' });
  const { balances, sourceSlot } = await readStreamedHlpBalances(owner, client);
  assert.deepEqual(balances, [{ market, side: 'base', hlpMint: baseHlp, amount: '40' }]);
  assert.equal(sourceSlot, 900_500_000);
}));

