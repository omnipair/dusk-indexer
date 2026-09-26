/** Disposable PostgreSQL only: every event fixture rolls back. */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { PoolClient } from 'pg';
import pool from '../config/database';
import { fixtureMarket, key, streamedEvent, streamedIdentity, streamedMarket, streamedRelease } from './duskStreamedFixtures';
import { readMarketExposures } from '../services/duskStatisticsSnapshot';

if (process.env.DUSK_ALLOW_DISPOSABLE_DB_TESTS !== 'true' || !process.env.DATABASE_URL)
  throw new Error('Set DUSK_ALLOW_DISPOSABLE_DB_TESTS=true and a disposable DATABASE_URL');
after(() => pool.end());
const active = streamedIdentity,{ market,ylp,baseHlp,quoteHlp } = fixtureMarket,owner = key(201),other = key(202);
const streamed = streamedEvent,createdMarket = streamedMarket;
async function transaction(work: (client: PoolClient) => Promise<void>) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO dusk_ingestion.protocol_identities(cluster,program_id,idl_hash,protocol_revision)
      VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,active);
    await work(client);
  } finally { await client.query('ROLLBACK'); client.release(); }
}
const rows = async (client: PoolClient,view: string,where = '') => (await client.query(
  `SELECT * FROM dusk_ingestion.${view} WHERE cluster=$1 AND program_id=$2 AND idl_hash=$3 AND protocol_revision=$4 ${where}`,active)).rows;

test('markets and their three LP mints come from MarketCreated',() => transaction(async client => {
  await createdMarket(client);
  const [created] = await rows(client,'streamed_markets');
  assert.equal(created.market,market); assert.equal(created.ylp_mint,ylp);
  const mints = (await rows(client,'streamed_lp_mints','ORDER BY kind')).map(row => [row.kind,row.lp_mint]);
  assert.deepEqual(mints,[['base_hlp',baseHlp],['quote_hlp',quoteHlp],['ylp',ylp]]);
}));

test('a leverage position carries its latest post-state and closes on its last event',() => transaction(async client => {
  const position = key(210),base = { market,position,owner,debt_asset_mint: key(206),collateral_asset_mint: key(207) };
  await streamed(client,'LeveragePositionOpened',{ ...base,collateral_amount: '100',debt_amount: '40',debt_shares: '40',closeout_value: '60' });
  await streamed(client,'LeveragePositionUpdated',{ ...base,collateral_amount: '150',debt_amount: '70',debt_shares: '69',closeout_value: '80' });
  let [row] = await rows(client,'streamed_leverage_positions');
  assert.equal(row.open,true); assert.equal(row.collateral_amount,'150'); assert.equal(row.debt_shares,'69');
  await streamed(client,'DebtFreePositionClosed',{ market,position,owner,leverage: false });
  [row] = await rows(client,'streamed_leverage_positions');
  assert.equal(row.open,true,'a borrow-side debt-free close is not this position');
  await streamed(client,'LeveragePositionClosed',{ ...base });
  [row] = await rows(client,'streamed_leverage_positions');
  assert.equal(row.open,false); assert.equal(row.last_event,'LeveragePositionClosed');
  assert.equal(row.collateral_amount,'150','the last post-state is kept after close');
}));

test('a borrow position is its last snapshot and closes with it',() => transaction(async client => {
  const position = key(220),snapshot = { market,position,owner,base_collateral: '10',quote_collateral: '0',
    fixed_base_shares: '0',fixed_quote_shares: '5',closed: false };
  await streamed(client,'BorrowPositionUpdated',snapshot);
  await streamed(client,'BorrowPositionUpdated',{ ...snapshot,base_collateral: '12',fixed_quote_shares: '7' });
  let [row] = await rows(client,'streamed_borrow_positions');
  assert.equal(row.open,true); assert.equal(row.base_collateral,'12'); assert.equal(row.fixed_quote_shares,'7');
  await streamed(client,'BorrowPositionUpdated',{ ...snapshot,base_collateral: '0',fixed_quote_shares: '0',closed: true });
  [row] = await rows(client,'streamed_borrow_positions');
  assert.equal(row.open,false);
}));

test('LP balances follow mints, burns and hook transfers per owner and mint',() => transaction(async client => {
  await createdMarket(client);
  await streamed(client,'LiquidityAdded',{ market,owner,ylp_amount: '1000' });
  await streamed(client,'LpTransferred',{ market,lp_mint: ylp,source_owner: owner,destination_owner: other,amount: '300' });
  await streamed(client,'LiquidityRemoved',{ market,owner: other,ylp_amount: '100' });
  await streamed(client,'HlpOpened',{ market,owner,asset_side: '1',hlp_amount: '50',ylp_amount: '999' });
  await streamed(client,'HlpClosed',{ market,owner,asset_side: '1',hlp_amount: '20',ylp_amount: '1' });
  await streamed(client,'LpTransferred',{ market,lp_mint: quoteHlp,source_owner: owner,destination_owner: owner,amount: '5' });
  const balances = (await rows(client,'streamed_lp_balances','ORDER BY kind,owner'))
    .map(row => [row.kind,row.owner === owner ? 'owner' : 'other',row.amount]);
  assert.deepEqual(balances,[['quote_hlp','owner','30'],['ylp','owner','700'],['ylp','other','200']]);
}));

test('market observations expose the crank\'s per-side state',() => transaction(async client => {
  const side = { live_reserve: '5',spot_price_nad: '1000000000',price_ema_nad: '990000000',
    swap_fee_growth_index_q64: '18446744073709551616',interest_growth_index_q64: '0',borrow_index_nad: '1000000000' };
  await streamed(client,'MarketObserved',{ market,slot: '1',ylp_supply: '42',base: side,quote: side });
  const [row] = await rows(client,'streamed_market_observations');
  assert.equal(row.market,market); assert.equal(row.ylp_supply,'42');
  assert.equal(row.base.swap_fee_growth_index_q64,'18446744073709551616');
}));

test('open interest sums open leverage collateral per market side',() => transaction(async client => {
  await streamedRelease(client,{ slot: 900_300_000,time: new Date(Date.now()-1000) });
  await createdMarket(client);
  const position = (address: string,collateral: string,amount: string) => ({ market,position: address,owner,
    debt_asset_mint: collateral === fixtureMarket.baseMint ? fixtureMarket.quoteMint : fixtureMarket.baseMint,
    collateral_asset_mint: collateral,collateral_amount: amount,debt_amount: '1',debt_shares: '1',closeout_value: '1' });
  await streamed(client,'LeveragePositionOpened',position(key(230),fixtureMarket.baseMint,'100'));
  await streamed(client,'LeveragePositionOpened',position(key(231),fixtureMarket.quoteMint,'40'));
  await streamed(client,'LeveragePositionOpened',position(key(232),fixtureMarket.baseMint,'7'));
  await streamed(client,'LeveragePositionClosed',position(key(232),fixtureMarket.baseMint,'7'));
  const exposures = await readMarketExposures(client);
  assert.deepEqual(exposures.markets,[{ market,baseCollateral: '100',quoteCollateral: '40',positions: 2 }]);
  assert.equal(exposures.sourceSlot,900_300_000); assert.equal(exposures.complete,true);
}));
