import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BorshCoder, Idl } from '@coral-xyz/anchor';
import { canonicalJson, sha256 } from '../config/duskProtocol';

const protocol = resolve(__dirname, '../../../protocol');
const root = resolve(protocol, 'candidates/devnet-2026-11-09-junior-exits');
const candidate = JSON.parse(readFileSync(resolve(root, 'candidate.json'), 'utf8'));
const currentIdl = JSON.parse(readFileSync(resolve(root, 'idl/dusk.json'), 'utf8')) as Idl;
const priorArchive = resolve(protocol, 'archive/devnet-2026-11-06-operators/idl/dusk.json');
const priorIdl = JSON.parse(readFileSync(existsSync(priorArchive) ? priorArchive : resolve(protocol, 'idl/dusk.json'), 'utf8')) as Idl;

test('junior exit candidate binds generated interfaces to the verified finalized deployment', () => {
  assert.equal(candidate.source.gitCommit, 'c5993da973f932d270714afea588fc5bc981a242');
  for (const program of candidate.programs) {
    const raw = readFileSync(resolve(root, program.idl.path));
    const parsed = JSON.parse(raw.toString());
    assert.equal(parsed.address, program.programId);
    assert.equal(sha256(raw), program.idl.sha256);
    assert.equal(sha256(canonicalJson(parsed)), program.idl.canonicalSha256);
    assert.equal(program.verifiedDeployment.idlRawSha256, program.idl.sha256);
    assert.equal(program.verifiedDeployment.idlCanonicalSha256, program.idl.canonicalSha256);
    assert.ok(program.verifiedDeployment.finalizedSlot > program.verifiedDeployment.previousSlot);
    assert.equal(program.verifiedDeployment.authority, 'FJWRK3XJeVD8njSvTFXyHwP2jkatvBqeVwcNAFe5zVfJ');
  }
});

test('the deployed preview layout decodes live debt, APR and utilization without the retired controller field', () => {
  const fixture = JSON.parse(readFileSync(resolve(root, 'fixtures/market-preview.json'), 'utf8'));
  const bytes = Buffer.from(fixture.returnData, 'base64');
  const decoded = new BorshCoder(currentIdl).types.decode('MarketPreview', bytes);
  assert.equal(decoded.slot.toString(), String(fixture.slot));
  for (const side of ['base', 'quote']) {
    assert.equal(decoded[side].total_debt.toString(), fixture.expected[`${side}Debt`]);
    assert.equal(decoded[side].borrow_apr_nad.toString(), fixture.expected[`${side}BorrowAprNad`]);
    assert.equal(decoded[side].utilization_bps.toString(), fixture.expected[`${side}UtilizationBps`]);
    assert.equal(decoded[side].rate_at_target_nad, undefined);
  }
  const stale = new BorshCoder(priorIdl).types.decode('MarketPreview', bytes);
  assert.equal(stale.base.total_debt.toString(), '21852238946991005566376853399');
  assert.notEqual(stale.base.total_debt.toString(), fixture.expected.baseDebt);
  assert.notEqual(stale.quote.total_debt.toString(), fixture.expected.quoteDebt);
});
