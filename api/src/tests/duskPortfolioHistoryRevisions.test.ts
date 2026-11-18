import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { loadPinnedProtocol, sha256 } from '../config/duskProtocol';
import { checkedPortfolioHistoryRevisions, readPortfolioHistoryRevisions } from '../services/duskPortfolioHistoryRevisions';

const protocol=resolve(__dirname,'../../../protocol');

test('the registered mainnet archive verifies byte-for-byte and deduplicates the current identity',()=>{
  const active=loadPinnedProtocol();
  assert.deepEqual(readPortfolioHistoryRevisions(protocol,active),[active]);
  // Synthetic future active identity tests archive selection only; it is not a
  // substitute for a real published layout-19 lock or decoder.
  const future={...active,revision:`${active.revision}-future-test`,dusk:{...active.dusk,idlCanonicalSha256:'a'.repeat(64)}};
  assert.deepEqual(readPortfolioHistoryRevisions(protocol,future),[future,active]);
});

test('absent archives preserve current-pin behavior without reading another deployment',()=>{
  const root=mkdtempSync(resolve(tmpdir(),'dusk-history-empty-'));
  try {const active=loadPinnedProtocol();assert.deepEqual(readPortfolioHistoryRevisions(root,active),[active]);}
  finally {rmSync(root,{recursive:true,force:true});}
});

test('cross-network/program archives, missing active identity and conflicting pins fail closed',()=>{
  const active=loadPinnedProtocol(),old={...active,revision:`${active.revision}-old-test`};
  for(const changed of [{...old,cluster:'devnet'},{...old,genesisHash:'wrong-genesis'},
    {...old,dusk:{...old.dusk,programId:'wrong-program'}},
    {...old,leverageDelegate:{...old.leverageDelegate,programId:'wrong-delegate'}}])
    assert.throws(()=>checkedPortfolioHistoryRevisions(active,[active,changed]),/network or program/);
  assert.throws(()=>checkedPortfolioHistoryRevisions(active,[old]),/omitted the active/);
  assert.throws(()=>checkedPortfolioHistoryRevisions(active,[active,{...active,dusk:{...active.dusk,binarySha256:'b'.repeat(64)}}]),/Conflicting active/);
  assert.throws(()=>checkedPortfolioHistoryRevisions(active,[active,old,{...old,dusk:{...old.dusk,binarySha256:'b'.repeat(64)}}]),/Conflicting portfolio/);
  assert.throws(()=>checkedPortfolioHistoryRevisions(active,Array(18).fill(active)),/bounded/);
});

test('archive lock/IDL mutation, revision substitution and path traversal cannot pass registry verification',()=>{
  const active=loadPinnedProtocol(),root=mkdtempSync(resolve(tmpdir(),'dusk-history-check-'));
  const registry=JSON.parse(readFileSync(resolve(protocol,'history-revisions.json'),'utf8'));
  const writeRegistry=()=>writeFileSync(resolve(root,'history-revisions.json'),JSON.stringify(registry));
  const archive=resolve(root,'archive',active.revision);
  try {
    cpSync(resolve(protocol,'archive',active.revision),archive,{recursive:true});writeRegistry();
    assert.equal(readPortfolioHistoryRevisions(root,active).length,1);
    const lockPath=resolve(archive,'protocol.lock.json'),lock=readFileSync(lockPath);
    writeFileSync(lockPath,Buffer.concat([lock,Buffer.from('\n')]));
    assert.throws(()=>readPortfolioHistoryRevisions(root,active),/lock hash differs/);
    writeFileSync(lockPath,lock);
    const idlPath=resolve(archive,'idl/dusk.json'),idl=readFileSync(idlPath);
    writeFileSync(idlPath,Buffer.concat([idl,Buffer.from('\n')]));
    assert.throws(()=>readPortfolioHistoryRevisions(root,active),/hashes to/);
    writeFileSync(idlPath,idl);
    const changed=JSON.parse(lock.toString());changed.revision+='-substituted';
    const changedBytes=Buffer.from(JSON.stringify(changed));writeFileSync(lockPath,changedBytes);
    registry.releases[0].lockSha256=sha256(changedBytes);writeRegistry();
    assert.throws(()=>readPortfolioHistoryRevisions(root,active),/revision differs/);
    registry.releases[0].revision='../outside';writeRegistry();
    assert.throws(()=>readPortfolioHistoryRevisions(root,active),/release reference/);
    registry.releases=Array(17).fill(registry.releases[0]);writeRegistry();
    assert.throws(()=>readPortfolioHistoryRevisions(root,active),/revision registry/);
  } finally {rmSync(root,{recursive:true,force:true});}
});
