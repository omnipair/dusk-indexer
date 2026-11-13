import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { BorshAccountsCoder, Idl } from '@coral-xyz/anchor';
import { canonicalJson, loadPinnedProtocol, loadProtocolAt, sha256 } from '../config/duskProtocol';
import { marketAccountLayout, marketLayoutVersion } from '../services/duskProtocolSchema';

const root = resolve(__dirname, '../../../protocol/candidates/next-2026-11-14-hlp-funding-layout17');
const candidate = JSON.parse(readFileSync(resolve(root, 'candidate.json'), 'utf8'));
const idl = JSON.parse(readFileSync(resolve(root, 'idl/dusk.json'), 'utf8')) as Idl;

test('layout 17 candidate pins both generated interfaces and the exact SDK without asserting deployment', () => {
  assert.equal(candidate.status, 'undeployed');
  assert.equal(candidate.source.gitCommit, 'c24e143f0fd16fa72772fe0c78e149309cf47738');
  for (const program of candidate.programs) {
    const bytes = readFileSync(resolve(root, program.idl.path));
    assert.equal(sha256(bytes), program.idl.sha256);
    assert.equal(sha256(canonicalJson(JSON.parse(bytes.toString()))), program.idl.canonicalSha256);
    assert.equal(program.deployment, undefined);
    assert.equal(program.binary, undefined);
  }
  const archive = resolve(root, '../../..', candidate.sdk.path);
  assert.equal(sha256(readFileSync(archive)), candidate.sdk.sha256);
  const sdk = JSON.parse(execFileSync('tar', ['-xOf', archive, 'package/package.json'], { encoding: 'utf8' }));
  assert.equal(sdk.version, candidate.sdk.version);
  assert.throws(() => loadProtocolAt(root), /protocol.lock/);
  assert.notEqual(loadPinnedProtocol().revision, candidate.revision);
});

test('layout 17 signed pricing translations do not shift real ownership, debt or trailing fields', () => {
  const coder = new BorshAccountsCoder(idl);
  const original = coder.decode('Market', readFileSync(resolve(root, 'fixtures/market.bin')));
  const bytes = readFileSync(resolve(root, 'fixtures/signed-market.bin'));
  const current = coder.decode('Market', bytes);
  assert.equal(marketLayoutVersion(idl), 17);
  assert.equal(marketAccountLayout(idl).accountBytes, bytes.length);
  assert.equal(current.version, 17);
  assert.equal(current.amm.hlp_funding_base_pricing_offset_nad.toString(), '-1267650600228229401496703205393');
  assert.equal(current.amm.hlp_funding_quote_pricing_offset_nad.toString(), '79228162514264337593543950355');
  assert.equal(current.last_update_slot.toString(), '123456789012345');
  assert.equal(current.operator.epoch.toString(), '987654321');
  for (const key of ['base_side', 'quote_side', 'debt', 'base_hlp_vault', 'quote_hlp_vault'])
    assert.equal(canonicalJson(current[key]), canonicalJson(original[key]), key);
});

test('delegate candidate decodes the EMA threshold and minimum payout independently', () => {
  const delegate = JSON.parse(readFileSync(resolve(root, 'idl/leverage_delegate.json'), 'utf8')) as Idl;
  const order = new BorshAccountsCoder(delegate).decode('LeverageOrder', readFileSync(resolve(root, 'fixtures/leverage-order.bin')));
  assert.equal(order.trigger_price_nad.toString(), '1234567890');
  assert.equal(order.min_owner_payout.toString(), '42');
  assert.equal(order.trigger_closeout_price_nad, undefined);
});
