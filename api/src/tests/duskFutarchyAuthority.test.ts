import test from 'node:test';
import assert from 'node:assert/strict';
import { PublicKey } from '@solana/web3.js';
import { futarchyAuthorityStatus } from '../services/duskFutarchyAuthority';

// Results are cached per program, so each test uses its own program ID.
function rpc(account: () => { owner: PublicKey } | null) {
  const calls = { count: 0 };
  return {
    calls,
    getAccountInfo: async () => {
      calls.count += 1;
      return account() as never;
    },
  };
}

test('derives the authority the devnet program reads', async () => {
  const program = new PublicKey('5EuU8artxWthfER6GTUY52TfL1aRsQH2TH8DsdGCa8cJ');
  const status = await futarchyAuthorityStatus(program.toBase58(), rpc(() => ({ owner: program })));
  assert.deepEqual(status, { address: 'CSNPsoWEP6ssqQaqKuvbHq2RbX2RaRCpxBopaXMG7rQ1', initialized: true });
});

test('an existing authority is never read again', async () => {
  const program = PublicKey.unique();
  const chain = rpc(() => ({ owner: program }));
  assert.equal((await futarchyAuthorityStatus(program.toBase58(), chain, 0)).initialized, true);
  assert.equal((await futarchyAuthorityStatus(program.toBase58(), chain, 3_600_000)).initialized, true);
  assert.equal(chain.calls.count, 1);
});

test('a missing authority is read again after thirty seconds', async () => {
  const program = PublicKey.unique();
  let account: { owner: PublicKey } | null = null;
  const chain = rpc(() => account);
  assert.equal((await futarchyAuthorityStatus(program.toBase58(), chain, 0)).initialized, false);
  account = { owner: program };
  assert.equal((await futarchyAuthorityStatus(program.toBase58(), chain, 29_000)).initialized, false);
  assert.equal((await futarchyAuthorityStatus(program.toBase58(), chain, 31_000)).initialized, true);
  assert.equal(chain.calls.count, 2);
});

test('an account owned by another program does not count', async () => {
  const program = PublicKey.unique();
  const status = await futarchyAuthorityStatus(program.toBase58(), rpc(() => ({ owner: PublicKey.unique() })));
  assert.equal(status.initialized, false);
});

test('a failed read is unknown and is not cached', async () => {
  const program = PublicKey.unique();
  let fail = true;
  const chain = {
    getAccountInfo: async () => {
      if (fail) throw new Error('429 Too Many Requests');
      return { owner: program } as never;
    },
  };
  assert.equal((await futarchyAuthorityStatus(program.toBase58(), chain, 0)).initialized, null);
  fail = false;
  assert.equal((await futarchyAuthorityStatus(program.toBase58(), chain, 1)).initialized, true);
});
