const Q64 = 1n << 64n;
const U64_MAX = (1n << 64n) - 1n;
const U128_MAX = (1n << 128n) - 1n;

export function unsigned(value: unknown, max = U128_MAX): bigint {
  if (typeof value === 'number' && !Number.isSafeInteger(value))
    throw new Error('Native amount must not lose integer precision');
  const text = String(value);
  if (!/^\d+$/.test(text)) throw new Error('Invalid unsigned native amount');
  const result = BigInt(text);
  if (result > max) throw new Error('Native amount overflow');
  return result;
}

/** Committed growth only: deferred market/vault updates are not invented. */
export function settleRecordedGrowth(input: { balance: unknown; index: unknown; checkpoint: unknown; remainder: unknown; accrued: unknown }) {
  const balance = unsigned(input.balance, U64_MAX), index = unsigned(input.index);
  const checkpoint = unsigned(input.checkpoint), remainder = unsigned(input.remainder, U64_MAX);
  const accrued = unsigned(input.accrued, U64_MAX);
  if (index < checkpoint) throw new Error('Yield growth regressed behind its checkpoint');
  const scaled = balance * (index-checkpoint) + remainder;
  const amount = accrued + scaled / Q64;
  if (amount > U64_MAX) throw new Error('Yield amount overflow');
  return { amount: amount.toString(), remainder: (scaled % Q64).toString() };
}
