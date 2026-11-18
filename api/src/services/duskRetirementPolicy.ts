/** Owner-approved retirement economics, 18 November 2026. Preparation only. */
export const RETIREMENT_CLOSURE_POLICY = Object.freeze({
  curve: 'existing-market-curve',
  fees: 'normal-protocol-fees',
  maximumNetPayoutSlippageBps: 100,
  treasuryTopUp: false,
  residualRecipient: '8s6Jdoh7tgUqmU3D2EmpNJHSvuN5U4NybpLAdsiMitwB',
  residualAfterAllClaimsOnly: true,
  immediateJuniorTerminalSettlement: true,
  juniorExitFeeBps: 50,
  juniorTerminalRequires: ['frozen-market','zero-fixed-debt','zero-isolated-debt','zero-hlp-funding'],
  liveExecutionAuthorized: false,
});

/** Integer ceiling is essential: flooring could permit more than 1% loss,
 * especially when a net entitlement is only a few token atoms. */
export function retirementMinimumNetPayout(quotedNet: bigint): bigint {
  if (quotedNet < 0n || quotedNet > (1n << 64n)-1n) throw new Error('Invalid retirement net quote');
  return (quotedNet*9900n+9999n)/10000n;
}
