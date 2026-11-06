import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PublicKey } from '@solana/web3.js';
import { BorshCoder, Idl } from '@coral-xyz/anchor';
import { projectOraclePolicy, oracleReportAccounts } from '../services/duskOraclePolicy';
import { marketAccountLayout } from '../services/duskProtocolSchema';

const root = resolve(__dirname, '../../../protocol/candidates/next-2026-10-31-8fadcc31');
const idl = JSON.parse(readFileSync(resolve(root, 'idl/dusk.json'), 'utf8')) as Idl;
const golden = JSON.parse(readFileSync(resolve(root, 'fixtures/oracle-wire.json'), 'utf8'));
const key = (n: number) => new PublicKey(Buffer.alloc(32,n)).toBase58();
const normalized = () => ({ ...golden.policy });
const native = () => ({ format: 0, provider: key(0), baseAccount: key(0), quoteAccount: key(0), baseFeedId: Array(32).fill(0),
  quoteFeedId: Array(32).fill(0), lambdaBps: 0, adjustmentCapNad: '0', maxAgeSeconds: 0, maxAgeSlots: '0', maxConfidenceBps: 0, maxPublishSkewSeconds: 0 });
const project = (policy: unknown) => projectOraclePolicy({ oracle: { policy } })!;

test('SDK-encoded Market and Oracle update agree with lossless indexed policy terms', () => {
  const coder = new BorshCoder(idl);
  const market = coder.accounts.decode('Market',Buffer.from(golden.marketHex,'hex'));
  const projected = projectOraclePolicy(market)!;
  assert.equal(projected.maxAgeSlots,'18446744073709551615');
  assert.equal(projected.adjustmentCapNad,'1250000000');
  assert.equal(projected.baseFeedId,'01'.repeat(32));
  assert.equal(projected.lambdaBps,3500);
  assert.deepEqual(oracleReportAccounts(projected),[key(3)]);
  const update = coder.types.decode('MarketParameterUpdate',Buffer.from(golden.updateHex,'hex')) as { Oracle: { '0': unknown } };
  assert.deepEqual(project(update.Oracle['0']),projected);
  const snake = Object.fromEntries(Object.entries(normalized()).map(([name,value]) => [name.replace(/[A-Z]/g,m => `_${m.toLowerCase()}`),value]));
  snake.base_feed_id = `0x${'01'.repeat(32)}`; snake.quote_feed_id = `0x${'00'.repeat(32)}`;
  assert.deepEqual(project(snake),projected);
});
test('missing policy is unknown; native and retained zero weight have no feed dependency', () => {
  assert.equal(projectOraclePolicy({}),null);
  assert.equal(project(native()).format,0);
  assert.deepEqual(oracleReportAccounts(project(native())),[]);
  assert.deepEqual(oracleReportAccounts(project({ ...normalized(),lambdaBps: 0 })),[]);
  for (const bad of [{ oracle: null },{ oracle: {} },{ oracle: { policy: {} } }]) assert.throws(() => projectOraclePolicy(bad));
});
test('Pyth reports remain distinct and complete; malformed and inexact policies fail closed', () => {
  const pyth = { ...normalized(),format: 2,provider: 'rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ',quoteAccount: key(4),quoteFeedId: Array(32).fill(2),maxPublishSkewSeconds: 5 };
  assert.deepEqual(oracleReportAccounts(project(pyth)),[key(3),key(4)]);
  for (const mutation of [
    { lambdaBps: 10000 },{ maxAgeSlots: Number.MAX_SAFE_INTEGER+1 },{ maxAgeSlots: '18446744073709551616' },
    { adjustmentCapNad: '1000000000' },{ maxAgeSeconds: 0 },{ baseFeedId: '0x01' },{ baseFeedId: Array(32).fill(256) },
    { provider: key(0) },{ format: 5 },{ baseAccount: undefined },{ maxAgeSlots: undefined },{ maxConfidenceBps: -1 },
  ]) assert.throws(() => project({ ...normalized(),...mutation }));
  assert.throws(() => project({ ...pyth,quoteAccount: pyth.baseAccount }));
  assert.throws(() => project({ ...pyth,quoteFeedId: pyth.baseFeedId }));
  assert.throws(() => project({ ...pyth,provider: key(2) }));
  assert.throws(() => project({ ...normalized(),quoteAccount: key(4) }));
});


test('market identity filters follow fixed serialized fields, including the boxed OracleState', () => {
  const layout = marketAccountLayout(idl);
  assert.deepEqual(layout,{ versionOffset: 333,prefixBytes: 334,accountBytes: 3461 });
  assert.equal(Buffer.from(golden.marketHex,'hex')[layout.versionOffset],7);
  const legacy = JSON.parse(readFileSync(resolve(root,'../../archive/devnet-2026-10-26-cd6f1ec/idl/dusk.json'),'utf8'));
  assert.equal(marketAccountLayout(legacy).versionOffset,8);
  const malformed = structuredClone(idl);
  const market = malformed.types!.find(row => row.name === 'Market')!;
  if (market.type.kind !== 'struct') throw Error('fixture');
  (market.type.fields as import('@coral-xyz/anchor/dist/cjs/idl').IdlField[]).unshift({ name: 'dynamic_prefix',type: 'string' });
  assert.throws(() => marketAccountLayout(malformed),/Dynamic/);
});

test('feed layout is independent of provider for policy projection and report accounts', () => {
  for (const format of [1,2,3,4]) {
    const ratio = [2,4].includes(format), pyth = [2,3].includes(format);
    const policy = { ...normalized(),format,provider: pyth ? 'rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ' : key(2),
      quoteAccount: ratio ? key(4) : key(0),quoteFeedId: Array(32).fill(ratio ? 2 : 0),maxPublishSkewSeconds: ratio ? 5 : 0 };
    assert.deepEqual(oracleReportAccounts(project(policy)),ratio ? [key(3),key(4)] : [key(3)]);
    assert.deepEqual(oracleReportAccounts(project({...policy,lambdaBps:0})),[]);
    if (ratio) assert.throws(() => project({...policy,quoteAccount:policy.baseAccount}));
    else assert.throws(() => project({...policy,maxPublishSkewSeconds:1}));
    if (pyth) assert.throws(() => project({...policy,provider:key(2)}));
  }
});
