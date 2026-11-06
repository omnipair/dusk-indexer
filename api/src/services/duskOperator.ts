import { PublicKey } from '@solana/web3.js';
import type { Dusk, Market, OperatorProposal } from '@omnipair/dusk-sdk';
import type { DuskDeploymentEnvelope } from './duskDeploymentService';
import { captureWithDeadline, currentDisplayState, displayRuntime } from './duskDisplayState';
import { displayPublicKey } from './duskOwnerAccounts';
import { marketLayoutVersion } from './duskProtocolSchema';
import { boundedDuskRpcRead, deriveMarketAddress, deriveOperatorProposalAddress } from './virtualBook/native';

/** Market authority and its single pending bundle, from one confirmed bank.
 * The first read discovers the pending key; the second re-reads both accounts
 * together. A concurrent replacement retries rather than combining banks. */
export async function captureMarketOperator(
  dusk: Dusk, marketAddress: string, deployment: DuskDeploymentEnvelope, signal?: AbortSignal,
) {
  const observedAt = Date.now(), key = new PublicKey(marketAddress);
  if (dusk.program.programId.toBase58() !== deployment.programId)
    throw new Error('Operator SDK deployment mismatch');
  const connection = dusk.program.provider.connection;
  const decodeMarket = (info: Awaited<ReturnType<typeof connection.getAccountInfo>>): Market => {
    if (!info || info.executable || !info.owner.equals(dusk.program.programId))
      throw Object.assign(new Error('Unknown operator market'), { status: 404 });
    const market = dusk.program.coder.accounts.decode<Market>('market', info.data);
    const [expected, bump] = deriveMarketAddress(market.baseSide.assetMint, market.quoteSide.assetMint,
      Uint8Array.from(market.paramsHash), dusk.program.programId);
    if (market.version !== marketLayoutVersion() || market.bump !== bump || !expected.equals(key))
      throw new Error('Operator market identity mismatch');
    return market;
  };
  let minimum = deployment.sourceSlot;
  for (let attempt = 0; attempt < 3; attempt++) {
    const first = await boundedDuskRpcRead(() => connection.getAccountInfoAndContext(key,
      { commitment: 'confirmed', minContextSlot: minimum }), signal);
    if (!Number.isSafeInteger(first.context.slot) || first.context.slot < minimum)
      throw new Error('Stale operator discovery');
    const pending = decodeMarket(first.value).operator.pending;
    const keys = pending.equals(PublicKey.default) ? [key] : [key, pending];
    const result = await boundedDuskRpcRead(() => connection.getMultipleAccountsInfoAndContext(keys,
      { commitment: 'confirmed', minContextSlot: first.context.slot }), signal);
    if (!Number.isSafeInteger(result.context.slot) || result.context.slot < first.context.slot)
      throw new Error('Stale operator snapshot');
    const market = decodeMarket(result.value[0]);
    if (!market.operator.pending.equals(pending)) { minimum = result.context.slot; continue; }
    const proposalInfo = result.value[1];
    if (keys.length === 2) {
      if (!proposalInfo || proposalInfo.executable || !proposalInfo.owner.equals(dusk.program.programId))
        throw new Error('Missing pending operator bundle');
      const proposal = dusk.program.coder.accounts.decode<OperatorProposal>('operatorProposal', proposalInfo.data);
      const [expected, bump] = deriveOperatorProposalAddress(key, proposal.nonce, dusk.program.programId);
      if (!proposal.market.equals(key) || !expected.equals(pending) || proposal.bump !== bump
        || !(await dusk.operator.verifyDigest(proposal)))
        throw new Error('Operator proposal identity mismatch');
    }
    return {
      schemaVersion: 'dusk-market-operator.v1' as const,
      market: { address: marketAddress, data: result.value[0]!.data.toString('base64') },
      proposal: proposalInfo ? { address: pending.toBase58(), data: proposalInfo.data.toString('base64') } : null,
      sourceSlot: result.context.slot, observedAt, expiresAt: observedAt + 15_000,
    };
  }
  throw Object.assign(new Error('Operator bundle changed during capture'), { status: 503 });
}

export function currentMarketOperator(market: unknown) {
  const address = displayPublicKey(market);
  return currentDisplayState(`operator:${address}`, async (deployment) => {
    const { dusk } = await displayRuntime();
    return captureWithDeadline(signal => captureMarketOperator(dusk, address, deployment, signal));
  });
}
