import test from 'node:test';
import assert from 'node:assert/strict';
import { Connection,PublicKey } from '@solana/web3.js';
import { deflateSync } from 'node:zlib';
import * as config from '../config/duskProtocol';
import * as deployments from '../services/duskDeploymentService';
import { captureMarketCatalogEvidence,validateMarketCatalogEvidence } from '../services/duskEmptyPortfolio';
import { projectPortfolioSource } from '../services/duskPortfolioSnapshots';
import { duskRawIdl } from '../services/duskMarketSimulation';
import { emptyPortfolioFixture } from './duskEmptyPortfolioFixtures';
import { fixtureKey } from './duskYieldCheckpointFixtures';

test('verified absence projects current zero without decoding or importing old balances',()=>{
  const source=emptyPortfolioFixture(),raw=JSON.stringify(source),projection=projectPortfolioSource(source);
  assert.equal(projection.owners.length,1);assert.equal(projection.owners[0].valuations.netPositionValueUsd,'0');
  assert.deepEqual(projection.owners[0].components,[]);assert.deepEqual(projection.income,{streams:[],unavailable:[]});
  assert.equal(projection.captureTime,source.emptyCatalog!.evidence.blockTime);
  assert.equal(projection.coverage.catalogBasis,'rpc-empty-markets.v1');assert.equal(projection.coverage.includesWalletBalances,false);
  assert.equal(JSON.stringify(source),raw);
});
test('absence cannot use a lagging catalog, mixed identity, nonfinalized or mismatched code evidence',()=>{
  const mutations:((s:ReturnType<typeof emptyPortfolioFixture>)=>void)[]=[
    s=>{delete s.emptyCatalog;},s=>{s.schemaVersion='dusk-portfolio-capture.v3';},s=>{s.catalog.basis='streamed-events.v1';},
    s=>{s.emptyCatalog!.evidence.markets=[fixtureKey(234).toBase58()];},s=>{s.emptyCatalog!.evidence.protocolRevision+='-other';},
    s=>{s.emptyCatalog!.evidence.idlHash='a'.repeat(64);},s=>{s.emptyCatalog!.evidence.genesisHash=fixtureKey(234).toBase58();},
    s=>{(s.emptyCatalog!.evidence as any).commitment='confirmed';},s=>{s.emptyCatalog!.evidence.deployments[0].binarySha256='0'.repeat(64);},
    s=>{s.emptyCatalog!.evidence.marketDiscriminator[0]^=1;},s=>{s.catalog.sourceFloor--;},s=>{s.catalog.throughSlot--;},
    s=>{s.emptyCatalog!.observationId='0';},s=>{s.deploymentIdentitySha256='0'.repeat(64);},
    s=>{s.emptyCatalog!.evidence.blockTime='invalid';},s=>{s.catalog.streamTime='2026-09-01T00:00:00Z';},
    s=>{s.catalog.items=[{address:fixtureKey(234).toBase58(),market:fixtureKey(234).toBase58(),owner:s.catalog.knownOwners[0],kind:'borrow',sourceSlot:1}];},
  ];
  for(const mutate of mutations){const source=emptyPortfolioFixture();mutate(source);assert.throws(()=>projectPortfolioSource(source));}
});

test('RPC absence verifies both executables and IDLs around a full finalized discriminator scan',async t=>{
  const pinned=config.loadPinnedProtocol(),base=config.loadCurrentProtocol(),binary=Buffer.from([1,2,3,4]);
  const idlBytes=Buffer.from(JSON.stringify(duskRawIdl())),compressed=deflateSync(idlBytes);
  const current={...base,dusk:{...base.dusk,binarySha256:config.sha256(binary),idlCanonicalSha256:config.sha256(config.canonicalJson(JSON.parse(idlBytes.toString()))),
    deployment:{...base.dusk.deployment,allocatedBinaryBytes:binary.length}},
    leverageDelegate:{...base.leverageDelegate,binarySha256:config.sha256(binary),idlCanonicalSha256:config.sha256(config.canonicalJson(JSON.parse(idlBytes.toString()))),
      deployment:{...base.leverageDelegate.deployment,allocatedBinaryBytes:binary.length}}};
  t.mock.method(config,'loadCurrentProtocol',()=>current);
  t.mock.method(deployments,'deploymentEnvelopeAt',async()=>({deploymentIdentitySha256:'b'.repeat(64)}));
  const slot=Math.max(current.dusk.deployment.deploySlot,current.leverageDelegate.deployment.deploySlot)+100;
  const rows=[current.dusk,current.leverageDelegate].flatMap(pin=>{
    const program=Buffer.alloc(36);program.writeUInt32LE(2);new PublicKey(pin.deployment.programData).toBuffer().copy(program,4);
    const data=Buffer.alloc(45+binary.length);data.writeUInt32LE(3);data.writeBigUInt64LE(BigInt(pin.deployment.deploySlot),4);data[12]=1;
    new PublicKey(pin.deployment.upgradeAuthority!).toBuffer().copy(data,13);binary.copy(data,45);
    const idl=Buffer.alloc(44+compressed.length);Buffer.from(config.sha256('internal:IdlAccount'),'hex').subarray(0,8).copy(idl);idl.writeUInt32LE(compressed.length,40);compressed.copy(idl,44);
    return [{executable:true,owner:new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111'),data:program},
      {executable:false,owner:new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111'),data},
      {executable:false,owner:new PublicKey(pin.programId),data:idl}];
  });
  let readCount=0;const rpc={
    getGenesisHash:async()=>pinned.genesisHash,
    getMultipleAccountsInfoAndContext:async(_keys:unknown,options:any)=>{assert.equal(options.commitment,'finalized');readCount++;return {context:{slot},value:rows};},
    getProgramAccounts:async(program:PublicKey,options:any)=>{assert.equal(program.toBase58(),pinned.dusk.programId);assert.equal(options.commitment,'finalized');assert.equal(options.withContext,true);
      assert.equal(options.filters.length,1);assert.deepEqual(options.dataSlice,{offset:0,length:0});assert.ok(options.minContextSlot>=slot);
      return {context:{slot},value:[]};},
    getBlock:async(request:number)=>{assert.equal(request,slot);return {blockhash:fixtureKey(233).toBase58(),parentSlot:slot-1,blockTime:1_780_000_000};},
  } as unknown as Connection;
  const evidence=await captureMarketCatalogEvidence(slot,rpc);assert.equal(readCount,2);assert.deepEqual(evidence.markets,[]);validateMarketCatalogEvidence(evidence);
  rows[1].data[45]^=1;
  await assert.rejects(captureMarketCatalogEvidence(slot,rpc),/FINALIZED_INVARIANT/);
});
