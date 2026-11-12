import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { Idl } from '@coral-xyz/anchor';
import { loadProtocolAt } from '../config/duskProtocol';
import { FrozenLeverageBank, LeverageMaximumInput, quoteRuntimeBytes, searchFrozenLeverageMaximum, quoteFrozenLeverageEntry, NativeLeverageRejection } from '../services/duskLeverageMaximumEngine';

const root = resolve(__dirname, '../../../protocol/archive/devnet-2026-11-09-fresh-layout14');
const idl = JSON.parse(readFileSync(resolve(root, 'idl/dusk.json'), 'utf8')) as Idl;
const pin = loadProtocolAt(root);
const suite = JSON.parse(gunzipSync(readFileSync(resolve(__dirname, '../../src/tests/fixtures/leverage-maximum-fresh-devnet-20261109.json.gz'))).toString()) as {
  protocolRevision: string; commonAccounts: FrozenLeverageBank['accounts']; fixtures: {
    input: LeverageMaximumInput; bank: FrozenLeverageBank; expected: { multiplierBps: string; candidates: number };
    deployment: { programBinarySha256: string; idlSha256: string }; rpcAcceptance: { err: unknown; unitsConsumed: number };
  }[];
};

test('archived layout-14 native capacity matches RPC-accepted receipts for both pool forms and debt directions', () => {
  assert.equal(suite.protocolRevision, pin.revision);
  assert.equal(suite.fixtures.length, 4);
  assert.equal(new Set(suite.fixtures.map(f => `${f.input.market}:${f.input.debtAsset}`)).size, 4);
  for (const f of suite.fixtures) {
    assert.equal(f.deployment.idlSha256, pin.dusk.idlCanonicalSha256);
    assert.equal(f.deployment.programBinarySha256, pin.dusk.binarySha256);
    assert.equal(f.rpcAcceptance.err, null);
    assert.ok(f.rpcAcceptance.unitsConsumed < 1_400_000);
    const bank = { ...f.bank, accounts: [...f.bank.accounts, ...suite.commonAccounts] };
    const binary = quoteRuntimeBytes(idl.address, f.deployment.programBinarySha256, resolve(root, 'quote-runtime'));
    assert.deepEqual(searchFrozenLeverageMaximum(f.input, bank, idl, binary), f.expected);
    assert.ok(quoteFrozenLeverageEntry(f.input, bank, idl, binary, f.expected.multiplierBps, f.input.marginAmount).collateral > 0n);
    assert.throws(() => quoteFrozenLeverageEntry(f.input, bank, idl, binary, String(BigInt(f.expected.multiplierBps) + 100n), f.input.marginAmount), NativeLeverageRejection);
  }
});
