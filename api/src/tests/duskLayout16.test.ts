import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BorshAccountsCoder, Idl } from '@coral-xyz/anchor';
import { canonicalJson, sha256 } from '../config/duskProtocol';
import { marketAccountLayout, marketLayoutVersion } from '../services/duskProtocolSchema';

const root = resolve(__dirname, '../../../protocol/candidates/devnet-2026-11-14-main-grid');
const candidate = JSON.parse(readFileSync(resolve(root, 'candidate.json'), 'utf8'));
const idl = JSON.parse(readFileSync(resolve(root, 'idl/dusk.json'), 'utf8')) as Idl;

test('the main plus grid candidate uses layout 16 and both generated interfaces', () => {
  assert.equal(candidate.source.gitCommit, '474ddcf4fcaecd1ed055238f1105a0a1323d7313');
  for (const program of candidate.programs) {
    const bytes = readFileSync(resolve(root, program.idl.path));
    assert.equal(sha256(bytes), program.idl.sha256);
    assert.equal(sha256(canonicalJson(JSON.parse(bytes.toString()))), program.idl.canonicalSha256);
  }
  const bytes = readFileSync(resolve(__dirname, '../../src/tests/fixtures/market-layout16.bin'));
  const market = new BorshAccountsCoder(idl).decode('Market', bytes);
  assert.equal(marketLayoutVersion(idl), 16);
  assert.equal(marketAccountLayout(idl).accountBytes, bytes.length);
  assert.equal(market.version, 16);
  assert.equal(market.amm.hlp_funding_base_pricing_offset_nad, undefined);
  assert.ok(market.base_side.fees.fee_swap_auction.accepted_mint);
  assert.ok(market.base_side.reserves.live_reserve.gtn(0));
});
