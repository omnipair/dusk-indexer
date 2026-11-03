import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BorshCoder, Idl } from '@coral-xyz/anchor';
import { seniorLpFields } from '../services/duskSeniorLp';
import { checkpointFixture } from './duskYieldCheckpointFixtures';

const idl = (path: string) => JSON.parse(readFileSync(resolve(__dirname,'../../../protocol',path),'utf8')) as Idl;

test('the historical and generated srLP IDLs decode identical account bytes', () => {
  const source = checkpointFixture().source();
  const bytes = Buffer.from(source.accounts.market!.data,'base64');
  const previous = new BorshCoder(idl('idl/dusk.json')).accounts.decode('Market',bytes) as any;
  const renamed = new BorshCoder(idl('candidates/next-2026-11-04-senior-lp/idl/dusk.json')).accounts.decode('Market',bytes) as any;
  assert.deepEqual(seniorLpFields(previous),renamed);
  assert.equal(previous.srlp_mint,undefined,'historical decoding is not mutated');
  assert.equal(seniorLpFields(previous).srlp_mint,previous.ylp_mint,'public keys preserve their native type and identity');
});

test('senior yield enum code zero survives the public variant rename', () => {
  const before = new BorshCoder(idl('idl/dusk.json')).types.decode('YieldTokenKind',Buffer.from([0]));
  const after = new BorshCoder(idl('candidates/next-2026-11-04-senior-lp/idl/dusk.json')).types.decode('YieldTokenKind',Buffer.from([0]));
  assert.deepEqual(seniorLpFields(before),after);
});

test('conflicting old and new fields are rejected, while canonical data keeps its references', () => {
  assert.throws(() => seniorLpFields({ ylp_mint: 'one',srlp_mint: 'two' }),/Conflicting/);
  const canonical = { shares: { srlp_supply: 12n } };
  assert.equal(seniorLpFields(canonical),canonical);
});
