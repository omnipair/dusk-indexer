import { PublicKey } from '@solana/web3.js';

type Fields = Record<string, unknown>;
const object = (value: unknown): Fields => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid oracle policy object');
  return value as Fields;
};
const field = (data: Fields, camel: string, snake = camel) => data[camel] ?? data[snake];
const U64 = (1n << 64n) - 1n;
const zeroKey = PublicKey.default.toBase58();
const zeroId = '00'.repeat(32);
const pythReceiver = 'rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ';
function integer(value: unknown, max: bigint, label: string): bigint {
  if (value == null || (typeof value !== 'number' && typeof value !== 'string' && typeof value !== 'bigint' && typeof value !== 'object')) throw new Error(`Missing oracle ${label}`);
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error(`Inexact oracle ${label}`);
  const text = String(value);
  if (!/^(0|[1-9]\d*)$/.test(text) || BigInt(text) > max) throw new Error(`Invalid oracle ${label}`);
  return BigInt(text);
}
function key(value: unknown): string {
  if (!(typeof value === 'string' || value instanceof PublicKey)) throw new Error('Invalid oracle public key');
  const parsed = new PublicKey(value).toBase58();
  if (typeof value === 'string' && parsed !== value) throw new Error('Noncanonical oracle public key');
  return parsed;
}
function id(value: unknown): string {
  if (typeof value === 'string' && /^(?:0x)?[0-9a-fA-F]{64}$/.test(value)) return value.replace(/^0x/, '').toLowerCase();
  if ((Array.isArray(value) || value instanceof Uint8Array) && value.length === 32) {
    return Array.from(value, byte => {
      const n = integer(byte, 255n, 'feed byte');
      return Number(n).toString(16).padStart(2, '0');
    }).join('');
  }
  throw new Error('Invalid oracle feed ID');
}
export interface IndexedOraclePolicy {
  format: number; provider: string; baseAccount: string; quoteAccount: string;
  baseFeedId: string; quoteFeedId: string; lambdaBps: number; adjustmentCapNad: string;
  maxAgeSeconds: number; maxAgeSlots: string; maxConfidenceBps: number; maxPublishSkewSeconds: number;
}

/** Complete configured terms, never a claim that an upstream feed is healthy.
 * Old account layouts omit OracleState: publish unknown rather than inventing
 * the new layout's all-zero native policy. Invalid present state is rejected. */
export function projectOraclePolicy(market: unknown): IndexedOraclePolicy | null {
  const raw = object(market);
  if (!Object.prototype.hasOwnProperty.call(raw, 'oracle')) return null;
  const p = object(object(raw.oracle).policy);
  const number = (camel: string, snake: string, max: bigint) => Number(integer(field(p, camel, snake), max, camel));
  const policy: IndexedOraclePolicy = {
    format: number('format', 'format', 255n), provider: key(p.provider),
    baseAccount: key(field(p, 'baseAccount', 'base_account')), quoteAccount: key(field(p, 'quoteAccount', 'quote_account')),
    baseFeedId: id(field(p, 'baseFeedId', 'base_feed_id')), quoteFeedId: id(field(p, 'quoteFeedId', 'quote_feed_id')),
    lambdaBps: number('lambdaBps', 'lambda_bps', 9999n),
    adjustmentCapNad: integer(field(p, 'adjustmentCapNad', 'adjustment_cap_nad'), U64, 'adjustmentCapNad').toString(),
    maxAgeSeconds: number('maxAgeSeconds', 'max_age_seconds', 0xffffffffn),
    maxAgeSlots: integer(field(p, 'maxAgeSlots', 'max_age_slots'), U64, 'maxAgeSlots').toString(),
    maxConfidenceBps: number('maxConfidenceBps', 'max_confidence_bps', 9999n),
    maxPublishSkewSeconds: number('maxPublishSkewSeconds', 'max_publish_skew_seconds', 0xffffffffn),
  };
  const native = policy.format === 0 && policy.lambdaBps === 0 && policy.provider === zeroKey
    && policy.baseAccount === zeroKey && policy.quoteAccount === zeroKey && policy.baseFeedId === zeroId && policy.quoteFeedId === zeroId
    && policy.adjustmentCapNad === '0' && policy.maxAgeSeconds === 0 && policy.maxAgeSlots === '0'
    && policy.maxConfidenceBps === 0 && policy.maxPublishSkewSeconds === 0;
  if (native) return policy;
  if (BigInt(policy.adjustmentCapNad) <= 1000000000n || !policy.maxAgeSeconds || policy.maxAgeSlots === '0'
    || policy.provider === zeroKey || policy.baseAccount === zeroKey || policy.baseFeedId === zeroId) throw new Error('Invalid configured oracle policy');
  if (policy.format === 1) {
    if (policy.quoteAccount !== zeroKey || policy.quoteFeedId !== zeroId || policy.maxPublishSkewSeconds !== 0) throw new Error('Normalized oracle requires one pair report');
  } else if (policy.format === 2) {
    if (policy.provider !== pythReceiver || policy.quoteAccount === zeroKey || policy.baseAccount === policy.quoteAccount
      || policy.quoteFeedId === zeroId || policy.baseFeedId === policy.quoteFeedId) throw new Error('Pyth oracle requires distinct base/quote feeds');
  } else throw new Error('Unsupported oracle format');
  return policy;
}

/** Zero weight has no feed-account dependency, including retained policies. */
export function oracleReportAccounts(policy: IndexedOraclePolicy | null): string[] {
  return !policy || policy.lambdaBps === 0 ? [] : [policy.baseAccount, ...(policy.format === 2 ? [policy.quoteAccount] : [])];
}
