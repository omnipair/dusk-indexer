import { PublicKey } from '@solana/web3.js';

/** Match the program's mint-specific retired-cohort proof. */
export function hlpCohortAddress(market: PublicKey, mint: PublicKey, program: PublicKey) {
  return PublicKey.findProgramAddressSync([Buffer.from('hlp_cohort'), market.toBuffer(), mint.toBuffer()], program);
}

export function assertRetiredHlpCohort(cohort: {
  market: PublicKey; mint: PublicKey; targetAsset: number; retired: boolean; bump: number;
}, market: PublicKey, mint: PublicKey, program: PublicKey, targetAsset?: number) {
  const [, bump] = hlpCohortAddress(market, mint, program);
  if (!cohort.market.equals(market) || !cohort.mint.equals(mint) || !cohort.retired || cohort.bump !== bump ||
    ![0, 1].includes(cohort.targetAsset) || (targetAsset !== undefined && cohort.targetAsset !== targetAsset))
    throw new Error('Invalid retired hLP cohort');
}
