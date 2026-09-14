import test from 'node:test';
import assert from 'node:assert/strict';
import { portfolioSampleSeconds, projectPortfolioSource } from '../services/duskPortfolioSnapshots';
import { portfolioFixture } from './duskPortfolioFixtures';
import { fixtureKey } from './duskYieldCheckpointFixtures';

test('portfolio sampling accepts explicit whole intervals and rejects malformed requests',() => {
  for (const input of [undefined,0,'0']) assert.equal(portfolioSampleSeconds(input),0);
  for (const input of ['3600',86400]) assert.equal(portfolioSampleSeconds(input),Number(input));
  for (const input of [null,'',[],['3600'],'1e3','60.5','-1','059',59,604801,Infinity])
    assert.throws(() => portfolioSampleSeconds(input),/Invalid portfolio history sampling interval/);
});

test('native portfolio replay combines indexed positions and non-ATA LP ownership',() => {
  const fixture = portfolioFixture(),result = projectPortfolioSource(fixture.source);
  assert.equal(result.owners.length,1); assert.equal(result.owners[0].owner,fixture.owner);
  assert.equal(result.owners[0].valuations.netPositionValueUsd,'51.95');
  assert.equal(result.coverage.atomicAcrossMarkets,false); assert.equal(result.coverage.historyComplete,false);
});
test('closed accounts preserve the known owner as an observed empty portfolio',() => {
  const result = projectPortfolioSource(portfolioFixture({ closed: true }).source);
  assert.equal(result.owners.length,1); assert.equal(result.owners[0].components.length,0);
  assert.equal(result.owners[0].valuations.netPositionValueUsd,'0'); assert.equal(result.coverage.closedAccounts.length,2);
});
test('LP account authority changes move current value while retaining the prior owner',() => {
  const changed = fixtureKey(177).toBase58(),fixture = portfolioFixture({ lpOwner: changed });
  const result = projectPortfolioSource(fixture.source);
  assert.equal(result.owners.find((row) => row.owner === fixture.owner)!.valuations.netPositionValueUsd,'1.95');
  assert.equal(result.owners.find((row) => row.owner === changed)!.valuations.netPositionValueUsd,'50');
  assert.deepEqual(result.coverage.ownerChanges,[{ address: fixture.tokenAddress,previousOwner: fixture.owner,owner: changed }]);
});
test('missing prices and failed previews retain positions with an unavailable total',() => {
  for (const options of [{ references: false },{ previewUnavailable: true }]) {
    const result = projectPortfolioSource(portfolioFixture(options).source);
    assert.equal(result.owners[0].components.length,2); assert.equal(result.owners[0].valuations.netPositionValueUsd,null);
    assert.equal(result.owners[0].valuations.quality,'incomplete');
  }
});
test('incomplete, duplicate, foreign and stale catalog captures cannot project',() => {
  const confirmed = portfolioFixture().source;
  (confirmed.groups[0] as unknown as { commitment: string }).commitment = 'confirmed';
  assert.throws(() => projectPortfolioSource(confirmed),/identity or state basis/);
  const missing = portfolioFixture().source; missing.groups[0].accounts.pop();
  assert.throws(() => projectPortfolioSource(missing),/complete catalog/);
  const duplicate = portfolioFixture().source; duplicate.groups[0].accounts.push(duplicate.groups[0].accounts[0]);
  assert.throws(() => projectPortfolioSource(duplicate),/duplicates/);
  const wrong = portfolioFixture().source; wrong.groups[0].deploymentIdentitySha256 = 'c'.repeat(64);
  assert.throws(() => projectPortfolioSource(wrong),/identity/);
  const stale = portfolioFixture().source; stale.catalog.lpScanSlots[0] -= 751;
  assert.throws(() => projectPortfolioSource(stale),/stale/);
});
