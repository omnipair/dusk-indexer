import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { PublicKey, SystemProgram } from '@solana/web3.js';
import { BorshCoder, Idl } from '@coral-xyz/anchor';
import { IdlCoder } from '@coral-xyz/anchor/dist/cjs/coder/borsh/idl';
import { AccountLayout } from '@solana/spl-token';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as simulation from '../services/duskMarketSimulation';
import { hlpCohortAddress } from '../services/duskHlpCohort';
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

test('retired hLP receipts replay with proven zero principal and require their captured cohort',async () => {
  const { source } = portfolioFixture();
  const rawIdl = JSON.parse(readFileSync(resolve(__dirname,'../../node_modules/@omnipair/dusk-sdk/dist/idl_v2.json'),'utf8')) as Idl;
  const coder = new BorshCoder(rawIdl),program = new PublicKey(rawIdl.address),mint = fixtureKey(180);
  const group = source.groups[0],market = new PublicKey(group.market);
  source.catalog.items[1].kind = 'base_hlp';
  source.catalog.items[1].lpMint = mint.toBase58();
  const tokenData = Buffer.from(group.accounts[1].account!.data,'base64');
  AccountLayout.encode({ ...AccountLayout.decode(tokenData),mint },tokenData);
  group.accounts[1].account!.data = tokenData.toString('base64');
  const [address,bump] = hlpCohortAddress(market,mint,program);
  const layout = IdlCoder.typeDefLayout({ typeDef: rawIdl.types!.find((type) => type.name === 'HlpCohort')!,types: rawIdl.types! });
  const cohort = layout.decode(Buffer.alloc(32768));
  Object.assign(cohort,{ market,mint,target_asset: 0,retired: true,bump });
  const proof = async () => ({ address: address.toBase58(),account: { owner: program.toBase58(),executable: false,
    data: (await coder.accounts.encode('HlpCohort',cohort)).toString('base64') } });
  group.hlpCohorts = [await proof()];
  const mocked = mock.method(simulation,'duskRawIdl',() => rawIdl);
  try {
    const retired = projectPortfolioSource(source).owners[0].components.find((row) => row.kind === 'base_hlp')!;
    assert.equal(retired.valuation.netUsd,'0');
    assert.ok(retired.issues.includes('hlp-retired'));
    cohort.target_asset = 1;
    group.hlpCohorts = [await proof()];
    assert.throws(() => projectPortfolioSource(source),/retired hLP cohort/);
    group.hlpCohorts = [];
    assert.throws(() => projectPortfolioSource(source),/no cohort evidence/);
  } finally { mocked.mock.restore(); }
});
test('closed accounts preserve the known owner as an observed empty portfolio',() => {
  const result = projectPortfolioSource(portfolioFixture({ closed: true }).source);
  assert.equal(result.owners.length,1); assert.equal(result.owners[0].components.length,0);
  assert.equal(result.owners[0].valuations.netPositionValueUsd,'0'); assert.equal(result.coverage.closedAccounts.length,2);
});
test('empty system accounts replay as closed positions and LP accounts without changing saved evidence',() => {
  for (const kind of ['borrow','leverage','ylp','base_hlp','quote_hlp'] as const) {
    const source = portfolioFixture({ closed: true }).source;
    source.catalog.items[0].kind = kind;
    for (const entry of source.groups[0].accounts)
      entry.account = { owner: SystemProgram.programId.toBase58(),executable: false,data: '' };
    const evidence = JSON.stringify(source);
    const result = projectPortfolioSource(source);
    assert.equal(result.owners.length,1);
    assert.deepEqual(result.owners[0].components,[]);
    assert.equal(result.owners[0].valuations.netPositionValueUsd,'0');
    assert.deepEqual(result.coverage.closedAccounts,source.catalog.items.map((item) => item.address).sort());
    assert.equal(JSON.stringify(source),evidence);
  }
});
test('a closed position does not discard remaining LP holdings in the same captured portfolio',() => {
  const { source,position,tokenAddress } = portfolioFixture();
  source.catalog.items[0].kind = 'leverage';
  source.groups[0].accounts[0].account = { owner: SystemProgram.programId.toBase58(),executable: false,data: '' };
  const result = projectPortfolioSource(source);
  assert.deepEqual(result.coverage.closedAccounts,[position]);
  assert.deepEqual(result.owners[0].components.map((component) => component.address),[tokenAddress]);
  assert.equal(result.owners[0].valuations.netPositionValueUsd,'50');
});
test('foreign, executable and nonempty accounts cannot be treated as closed',() => {
  const empty = { owner: SystemProgram.programId.toBase58(),executable: false,data: '' };
  for (const account of [{ ...empty,owner: fixtureKey(179).toBase58() },
    { ...empty,executable: true },{ ...empty,data: 'AA==' }]) {
    const source = portfolioFixture().source;
    source.groups[0].accounts[0].account = account;
    assert.throws(() => projectPortfolioSource(source),/Invalid portfolio raw account/);
  }
  const source = portfolioFixture().source;
  source.groups[0].marketAccount = empty;
  assert.throws(() => projectPortfolioSource(source),/Invalid portfolio raw account/);
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
  const stale = portfolioFixture().source; stale.catalog.streamTime = '2026-09-01T23:59:04.999Z';
  assert.throws(() => projectPortfolioSource(stale),/stale/);
  const early = portfolioFixture().source; early.catalog.throughSlot += 2; early.catalog.sourceFloor += 2;
  assert.throws(() => projectPortfolioSource(early),/stale/);
});
