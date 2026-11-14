import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { loadCurrentProtocol,loadPinnedProtocol,loadProtocolAt,parseProgramDeployment } from '../config/duskProtocol';

test('deployment starts after both pinned upgrades and preserves exact on-chain identity',() => {
  const pin=loadPinnedProtocol();
  assert.equal(pin.historyFirstSlot,Math.max(pin.dusk.deployment.deploySlot,pin.leverageDelegate.deployment.deploySlot)+1);
  assert.deepEqual(parseProgramDeployment(pin.dusk.deployment,pin.dusk.programId),pin.dusk.deployment);
});
test('current binary pins follow both compatible upgrades while history retains the original slots', () => {
  const pin = loadPinnedProtocol();
  const current = loadCurrentProtocol();
  const metadata = JSON.parse(readFileSync(resolve(__dirname,'../../../protocol/compatible-deployment.json'),'utf8'));
  assert.equal(current.revision, pin.revision);
  assert.equal(current.historyFirstSlot, pin.historyFirstSlot);
  for (const [original, deployed, compatible] of [
    [pin.dusk, current.dusk, metadata],
    [pin.leverageDelegate, current.leverageDelegate, metadata.leverageDelegate],
  ] as const) {
    assert.equal(deployed.programId, original.programId);
    assert.equal(deployed.idlCanonicalSha256, original.idlCanonicalSha256);
    assert.equal(deployed.deployment.programData, original.deployment.programData);
    assert.equal(deployed.deployment.deploySlot, compatible?.deploySlot ?? original.deployment.deploySlot);
    assert.equal(deployed.binarySha256, compatible?.binarySha256 ?? original.binarySha256);
    assert.equal(deployed.deployment.allocatedBinaryBytes, compatible?.allocatedBinaryBytes ?? original.deployment.allocatedBinaryBytes);
  }
});

test('missing authority and invalid ProgramData, deployment slot or allocation cannot form a pin',() => {
  const pin=loadPinnedProtocol().dusk;
  for (const change of [{programData:pin.programId},{deploySlot:0},{deploySlot:Number.MAX_SAFE_INTEGER},
    {allocatedBinaryBytes:0},{upgradeAuthority:undefined},{upgradeAuthority:'invalid'}]) {
    assert.throws(() => parseProgramDeployment({...pin.deployment,...change},pin.programId));
  }
  assert.throws(() => parseProgramDeployment(undefined,pin.programId));
  assert.equal(parseProgramDeployment({...pin.deployment,upgradeAuthority:null},pin.programId).upgradeAuthority,null);
});

test('every archived decoder loads from its own verified IDL files',() => {
  const root=resolve(__dirname,'../../../protocol/archive');
  for (const revision of readdirSync(root))
    assert.equal(loadProtocolAt(resolve(root,revision)).revision,revision);
});

test('protocol pins require the genesis belonging to their declared cluster', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'dusk-cluster-pin-'));
  const source = resolve(__dirname, '../../../protocol');
  const lock = JSON.parse(readFileSync(resolve(source, 'protocol.lock.json'), 'utf8'));
  mkdirSync(resolve(root, 'idl'));
  cpSync(resolve(source, 'idl'), resolve(root, 'idl'), { recursive: true });
  try {
    for (const [name, genesisHash] of [
      ['devnet', 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'],
      ['mainnet-beta', '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'],
    ]) {
      lock.cluster = { name, genesisHash };
      writeFileSync(resolve(root, 'protocol.lock.json'), JSON.stringify(lock));
      assert.equal(loadProtocolAt(root).cluster, name);
      lock.cluster.genesisHash = name === 'devnet'
        ? '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'
        : 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
      writeFileSync(resolve(root, 'protocol.lock.json'), JSON.stringify(lock));
      assert.throws(() => loadProtocolAt(root), /exact supported Solana cluster and genesis/);
    }
    lock.cluster.name = 'testnet';
    writeFileSync(resolve(root, 'protocol.lock.json'), JSON.stringify(lock));
    assert.throws(() => loadProtocolAt(root), /exact supported Solana cluster and genesis/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
