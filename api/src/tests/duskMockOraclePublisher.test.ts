import test from 'node:test';
import assert from 'node:assert/strict';
import { LAMPORTS_PER_SOL, SendTransactionError } from '@solana/web3.js';
import { PublisherOutOfFundsError, describeRefreshFailure, publisherRunway, redactRpcSecrets } from '../services/duskMockOraclePublisher';

const DEVNET_RENT_FLOOR = 650240;
const RPC = 'https://devnet.example-rpc.com/?api-key=0123456789abcdef0123';

test('runway counts only refreshes that leave the payer rent exempt', () => {
  // 2026-11-04: the publisher stopped at 655,000 lamports on devnet.
  assert.deepEqual(publisherRunway(655000, DEVNET_RENT_FLOOR, 15), { refreshes: 0, seconds: 0 });
  assert.deepEqual(publisherRunway(660000, DEVNET_RENT_FLOOR, 15), { refreshes: 1, seconds: 15 });
  assert.deepEqual(publisherRunway(0, DEVNET_RENT_FLOOR, 15), { refreshes: 0, seconds: 0 });
  const oneSol = publisherRunway(LAMPORTS_PER_SOL + 655000, DEVNET_RENT_FLOOR, 15);
  assert.equal(oneSol.refreshes, 200000);
  assert.equal(Math.floor(oneSol.seconds / 86400), 34);
});

test('redaction removes the endpoint and its key wherever they appear', () => {
  const quoted = redactRpcSecrets(`request to ${RPC} failed, key 0123456789abcdef0123`, RPC);
  assert.ok(!quoted.includes('0123456789abcdef0123'));
  assert.ok(!quoted.includes('example-rpc'));
  const pathKey = 'https://rpc.example.com/a1b2c3d4e5f6a7b8c9d0/';
  assert.ok(!redactRpcSecrets('token a1b2c3d4e5f6a7b8c9d0 rejected', pathKey).includes('a1b2c3d4e5f6a7b8c9d0'));
  assert.equal(redactRpcSecrets('wss://x.example/?api_key=secret123 dropped', RPC), '<url> dropped');
  assert.equal(redactRpcSecrets('x'.repeat(1000), RPC).length, 400);
});

test('failures name their cause without exposing the RPC key', () => {
  const rent = new SendTransactionError({ action: 'simulate', signature: '', logs: [],
    transactionMessage: 'Transaction simulation failed: Transaction results in an account (0) with insufficient funds for rent' });
  assert.equal(describeRefreshFailure(rent, RPC).reason, 'publisher-out-of-funds');
  const empty = new PublisherOutOfFundsError('Publisher holds 655000 lamports; a refresh needs at least 655240');
  assert.deepEqual(describeRefreshFailure(empty, RPC),
    { reason: 'publisher-out-of-funds', detail: 'Publisher holds 655000 lamports; a refresh needs at least 655240' });
  assert.equal(describeRefreshFailure(new Error('429 Too Many Requests: {"message":"rate limited"}'), RPC).reason, 'rpc-rate-limited');
  const unreachable = describeRefreshFailure(new TypeError(`fetch failed (${RPC})`), RPC);
  assert.equal(unreachable.reason, 'rpc-unreachable');
  assert.ok(!unreachable.detail.includes('0123456789abcdef0123'));
  assert.equal(describeRefreshFailure(new Error('Signature abc has expired: block height exceeded.'), RPC).reason, 'transaction-expired');
  const rejected = new SendTransactionError({ action: 'simulate', signature: '',
    transactionMessage: 'Transaction simulation failed: Error processing Instruction 0: custom program error: 0x1',
    logs: ['Program 8aaF invoke [1]', 'Program log: report invalidated', 'Program 8aaF failed: custom program error: 0x1'] });
  const described = describeRefreshFailure(rejected, RPC);
  assert.equal(described.reason, 'transaction-rejected');
  assert.ok(described.detail.includes('Program log: report invalidated'));
  assert.equal(describeRefreshFailure('boom', RPC).reason, 'unexpected');
});
