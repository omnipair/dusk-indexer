import assert from 'node:assert/strict';
import test from 'node:test';
import { PublicKey } from '@solana/web3.js';
import { parseYieldClaim } from '../services/duskYieldClaims';

const address = (value: number) => new PublicKey(Buffer.alloc(32, value)).toBase58();
const payload = () => ({ owner: address(1), market: address(2), lp_mint: address(3), asset_mint: address(4),
  recipient: address(5), token_kind: '1', swap_fee_amount: '9007199254740993', interest_amount: '7', recipient_credit: '9007199254740990',
  metadata: { market: address(2), signer: address(6), slot: '123' } });

test('claim history preserves owner, delegated caller, recipient, and exact gross/net payments', () => {
  const result = parseYieldClaim(payload(), '123');
  assert.equal(result.owner, address(1));
  assert.equal(result.recipient, address(5));
  assert.equal(result.caller, address(6));
  assert.equal(result.tokenKind, 'hlp');
  assert.equal(result.grossAmount, '9007199254741000');
  assert.equal(result.recipientCredit, '9007199254740990');
});

test('claim projection rejects precision loss, impossible credit, and a mismatched event source', () => {
  assert.throws(() => parseYieldClaim({ ...payload(), swap_fee_amount: 9007199254740992 }, '123'), /amount/);
  assert.throws(() => parseYieldClaim({ ...payload(), swap_fee_amount: '18446744073709551615' }, '123'), /inconsistent/);
  assert.throws(() => parseYieldClaim({ ...payload(), recipient_credit: '18446744073709551615' }, '123'), /inconsistent/);
  assert.throws(() => parseYieldClaim({ ...payload(), token_kind: '2' }, '123'), /kind/);
  assert.throws(() => parseYieldClaim(payload(), '124'), /metadata/);
  assert.throws(() => parseYieldClaim({ ...payload(), metadata: { ...payload().metadata, market: address(7) } }, '123'), /metadata/);
  assert.throws(() => parseYieldClaim({ ...payload(), owner: 'invalid' }, '123'));
});
