import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BorshCoder, Idl } from '@coral-xyz/anchor';

const protocol = resolve(__dirname, '../../../protocol');
const root = resolve(protocol, 'candidates/devnet-2026-11-09-combined-layout14');
const fixture = JSON.parse(readFileSync(resolve(root, 'fixtures/markets.json'), 'utf8'));
const current = new BorshCoder(JSON.parse(readFileSync(resolve(root, 'idl/dusk.json'), 'utf8')) as Idl);
const archive = resolve(protocol, 'archive/devnet-2026-11-06-operators/idl/dusk.json');
const prior = new BorshCoder(JSON.parse(readFileSync(existsSync(archive) ? archive : resolve(protocol, 'idl/dusk.json'), 'utf8')) as Idl);

test('fresh layout-14 market observations decode both rate bands and the real response half-life', () => {
  for (const market of fixture.markets) {
    const account = current.accounts.decode('Market', Buffer.from(market.accountData, 'base64'));
    const irm = account.config.irm;
    assert.equal(account.version, 14);
    assert.equal(irm.lower_signal_nad.toString(), market.expected.lowerSignalNad);
    assert.equal(irm.upper_signal_nad.toString(), market.expected.upperSignalNad);
    assert.equal(irm.lower_utilization_bps, market.expected.lowerUtilizationBps);
    assert.equal(irm.upper_utilization_bps, market.expected.upperUtilizationBps);
    assert.equal(irm.half_life_ms.toString(), market.expected.halfLifeMs);
    assert.equal(account.tranches.junior_reserve_shares.toString(), market.expected.fundedJuniorReserveShares);
  }
  const primary = fixture.markets[0];
  const stale = prior.accounts.decode('Market', Buffer.from(primary.accountData, 'base64'));
  assert.notEqual(stale.config.irm.half_life_ms.toString(), primary.expected.halfLifeMs);
});

test('fresh market previews report zero debt and 4 percent APR instead of shifted debt bytes', () => {
  for (const market of fixture.markets) {
    const bytes = Buffer.from(market.returnData, 'base64');
    const preview = current.types.decode('MarketPreview', bytes);
    assert.equal(preview.slot.toString(), String(market.simulationSourceSlot));
    for (const side of ['base', 'quote']) {
      assert.equal(preview[side].total_debt.toString(), market.expected[`${side}Debt`]);
      assert.equal(preview[side].borrow_apr_nad.toString(), market.expected[`${side}BorrowAprNad`]);
      assert.equal(preview[side].utilization_bps.toString(), '0');
    }
  }
  const primary = fixture.markets[0];
  const stale = prior.types.decode('MarketPreview', Buffer.from(primary.returnData, 'base64'));
  assert.notEqual(stale.base.total_debt.toString(), primary.expected.baseDebt);
  assert.notEqual(stale.base.borrow_apr_nad.toString(), primary.expected.baseBorrowAprNad);
  assert.throws(() => prior.types.decode('MarketPreview', Buffer.from(fixture.markets[1].returnData, 'base64')), /Invalid bool/);
});
