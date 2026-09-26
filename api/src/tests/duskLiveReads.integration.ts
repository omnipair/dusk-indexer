/** Disposable PostgreSQL only: every fixture rolls back. Discovery for the
 * live reads comes from streamed events and delegate instructions. */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { PoolClient } from 'pg';
import pool from '../config/database';
import { loadPinnedProtocol } from '../config/duskProtocol';
import { readStreamedBorrowPositions } from '../services/duskBorrowValuation';
import { readOpenEntryOrderAddresses } from '../services/duskEntryOrderBook';
import { readStreamedHlpBalances } from '../services/duskHlpPositions';
import { fixtureMarket, key, streamedEvent, streamedIdentity, streamedMarket, streamedRelease } from './duskStreamedFixtures';

if (process.env.DUSK_ALLOW_DISPOSABLE_DB_TESTS !== 'true' || !process.env.DATABASE_URL)
  throw new Error('Set DUSK_ALLOW_DISPOSABLE_DB_TESTS=true and a disposable DATABASE_URL');
after(() => pool.end());

const pin = loadPinnedProtocol();
const delegateIdentity = [pin.cluster, pin.leverageDelegate.programId, pin.leverageDelegate.idlCanonicalSha256, pin.revision];
const { market, baseHlp } = fixtureMarket;
const owner = key(201),
  other = key(202);

async function transaction(work: (client: PoolClient) => Promise<void>) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const identity of [streamedIdentity, delegateIdentity])
      await client.query(`INSERT INTO dusk_ingestion.protocol_identities(cluster,program_id,idl_hash,protocol_revision)
        VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`, identity);
    await streamedRelease(client, { slot: 900_500_000, time: new Date(Date.now() - 1000) });
    await work(client);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
let nextSlot = pin.historyFirstSlot + 10;
/** One delegate instruction, as the daemon records it. */
async function instruction(client: PoolClient, name: string, named: Record<string, string>, path = [0]) {
  const signature = Array.from(randomBytes(88), (byte) => ALPHABET[byte % 58]).join('');
  const slot = nextSlot++;
  const ok = await client.query('SELECT dusk_ingestion.record_order_instruction($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) AS ok', [
    ...delegateIdentity, [...delegateIdentity, signature, path.join('.')].join('|'), signature, slot, '3'.repeat(44),
    1_790_000_000 + slot - pin.historyFirstSlot, path, name, named.order, named.owner ?? named.order_owner, named.market ?? null,
    Buffer.from([1]), JSON.stringify({ accounts: { named, all: Object.values(named) }, arguments: {} }),
  ]);
  assert.equal(ok.rows[0].ok, true);
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

test('open entry orders are created orders whose latest lifecycle instruction is still their creation', () => transaction(async (client) => {
  const create = (order: string, where = market) => instruction(client, 'create_leverage_entry_order', { market: where, order, owner });
  await create(key(221));
  await create(key(222));
  await instruction(client, 'cancel_leverage_entry_order', { order: key(222), owner });
  await create(key(223));
  await instruction(client, 'execute_leverage_entry_order', { order: key(223), market, owner });
  await create(key(224), key(230));
  // The same order id reused after a cancel is open again.
  await create(key(225));
  await instruction(client, 'cancel_leverage_entry_order', { order: key(225), owner });
  await create(key(225));
  assert.deepEqual((await readOpenEntryOrderAddresses(market, client)).sort(), [key(221), key(225)].sort());
}));

