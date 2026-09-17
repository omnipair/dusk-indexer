import { PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { settleRecordedGrowth, unsigned } from './duskYieldAccounting';

const U64_MAX = (1n << 64n)-1n;
type Fields = Record<string, unknown>;
const fields = (value: unknown): Fields => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Missing native yield fields');
  return value as Fields;
};
export const keyString = (value: unknown): string => {
  const text = value instanceof PublicKey ? value.toBase58() : value;
  if (typeof text !== 'string' || new PublicKey(text).toBase58() !== text) throw new Error('Invalid native yield key');
  return text;
};

export function yieldBindings(value: unknown) {
  const account = fields(value);
  const owner = keyString(account.owner), market = keyString(account.market), lpMint = keyString(account.lp_mint), assetMint = keyString(account.asset_mint);
  const kind = unsigned(account.token_kind, 1n);
  const lpTokenAccount = getAssociatedTokenAddressSync(new PublicKey(lpMint),new PublicKey(owner),true,TOKEN_2022_PROGRAM_ID).toBase58();
  return { owner, market, lpMint, assetMint, tokenKind: Number(kind), lpTokenAccount };
}

/** Committed indexes only. Harvest also performs lazy market/vault updates. */
export function projectRecordedYield(input: {
  programId: string; yieldAddress: string; yield: unknown; market: unknown; lpTokenAccount: string; lpBalance: string;
}) {
  const account = fields(input.yield), market = fields(input.market), bound = yieldBindings(account);
  if (input.lpTokenAccount !== bound.lpTokenAccount) throw new Error('Yield checkpoint requires the canonical owner LP account');
  const program = new PublicKey(input.programId);
  const [yieldAddress,yieldBump] = PublicKey.findProgramAddressSync([
    Buffer.from('yield'),new PublicKey(bound.market).toBuffer(),new PublicKey(bound.owner).toBuffer(),
    new PublicKey(bound.lpMint).toBuffer(),new PublicKey(bound.assetMint).toBuffer(),Buffer.from([bound.tokenKind]),
  ],program);
  if (yieldAddress.toBase58() !== input.yieldAddress || unsigned(account.bump,255n) !== BigInt(yieldBump))
    throw new Error('Yield account PDA does not match its bindings');
  const base = fields(market.base_side), quote = fields(market.quote_side);
  const baseMint = keyString(base.asset_mint), quoteMint = keyString(quote.asset_mint);
  const paramsHash = market.params_hash;
  if (!Array.isArray(paramsHash) || paramsHash.length !== 32 || paramsHash.some((value) => !Number.isInteger(value) || value<0 || value>255))
    throw new Error('Invalid market parameter hash');
  const [marketAddress,marketBump] = PublicKey.findProgramAddressSync([Buffer.from('market_v2'),new PublicKey(baseMint).toBuffer(),new PublicKey(quoteMint).toBuffer(),Buffer.from(paramsHash)],program);
  if (marketAddress.toBase58() !== bound.market || unsigned(market.bump,255n) !== BigInt(marketBump)) throw new Error('Market PDA differs from the yield binding');
  const revenueSide = bound.assetMint === baseMint ? 'base' : bound.assetMint === quoteMint ? 'quote' : undefined;
  if (!revenueSide) throw new Error('Yield asset is not a market asset');
  const side = revenueSide === 'base' ? base : quote;
  let swapIndex: unknown, interestIndex: unknown;
  if (bound.tokenKind === 0) {
    if (keyString(market.ylp_mint) !== bound.lpMint) throw new Error('yLP mint differs from the market');
    const fees = fields(side.fees);
    swapIndex = fees.swap_fee_growth_index_q64; interestIndex = fees.interest_growth_index_q64;
  } else {
    const vault = bound.lpMint === keyString(base.hlp_mint) ? fields(market.base_hlp_vault)
      : bound.lpMint === keyString(quote.hlp_mint) ? fields(market.quote_hlp_vault) : undefined;
    if (!vault) throw new Error('hLP mint differs from the market');
    swapIndex = vault[`${revenueSide}_swap_fee_growth_index_q64`];
    interestIndex = vault[`${revenueSide}_interest_growth_index_q64`];
  }
  const lpBalance = unsigned(input.lpBalance,U64_MAX).toString();
  const swap = settleRecordedGrowth({ balance: lpBalance,index: swapIndex,checkpoint: account.swap_fee_checkpoint_q64,
    remainder: account.swap_fee_remainder_q64,accrued: account.accrued_swap_fee_amount });
  const interest = settleRecordedGrowth({ balance: lpBalance,index: interestIndex,checkpoint: account.interest_checkpoint_q64,
    remainder: account.interest_remainder_q64,accrued: account.accrued_interest_amount });
  const total = unsigned(BigInt(swap.amount)+BigInt(interest.amount),U64_MAX).toString();
  return { ...bound, basis: 'recorded-growth.v1' as const, assetDecimals: Number(unsigned(side.asset_decimals,255n)), lpBalance,
    swapFeeAmount: swap.amount,interestAmount: interest.amount,totalAmount: total,
    swapRemainderQ64: swap.remainder,interestRemainderQ64: interest.remainder };
}
