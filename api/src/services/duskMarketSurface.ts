import { duskApiConfig, loadPinnedProtocol } from '../config/duskProtocol';
import { DuskDeploymentEnvelope } from './duskDeploymentService';
import { discoverMarkets, marketPayload } from './duskMarketService';
import { cache } from '../utils/cache';

/**
 * The deployment's market surface, as the read boundary expects it: the
 * configuration describes the primary market and lists every market, and the
 * list endpoint returns all of them in one page.
 */
async function deploymentPayload(deployment: DuskDeploymentEnvelope) {
  const identity = deployment.deploymentIdentitySha256;
  const pinned = loadPinnedProtocol();
  const config = duskApiConfig();
  const { markets, sourceSlot } = await discoverMarkets();
  const projected = await Promise.all(
    markets.map((market) =>
      marketPayload(market.address, market.account, sourceSlot, identity),
    ),
  );
  // Deterministic ordering first: getProgramAccounts has none, so without
  // this the list reshuffles as markets are created and `primary` moves with
  // it. DUSK_PRIMARY_MARKET pins the choice; otherwise the lowest address
  // wins, which at least does not change under an unrelated deployment.
  projected.sort((left, right) =>
    String(left.marketAddress).localeCompare(String(right.marketAddress)),
  );
  const pinnedPrimary = config.primaryMarket
    ? projected.find(
        (market) => String(market.marketAddress) === config.primaryMarket,
      )
    : undefined;
  const primary = pinnedPrimary ?? projected[0];

  const observedSlot = projected.reduce((highest, market) => {
    const state = market.state as Record<string, unknown>;
    return Math.max(
      highest,
      Number(state.sourceSlot ?? 0),
      Number(state.healthSourceSlot ?? 0),
    );
  }, sourceSlot);

  return {
    projected,
    sourceSlot: observedSlot,
    config: {
      network: config.network,
      protocolRevision: pinned.revision,
      programId: pinned.dusk.programId,
      leverageDelegateProgramId: pinned.leverageDelegate.programId,
      // The surrounding read brackets this authority with fresh observations.
      payer: deployment.programUpgradeAuthority,
      markets: projected.map((market) => ({
        label: market.label,
        market: market.marketAddress,
        marketKind: market.marketKind,
        baseMint: market.baseMint,
        quoteMint: market.quoteMint,
        baseDecimals: market.baseDecimals,
        quoteDecimals: market.quoteDecimals,
        ylpMint: market.ylpMint,
        baseHlpMint: market.baseHlpMint,
        quoteHlpMint: market.quoteHlpMint,
        paramsHash: market.paramsHash,
        seededLiquidity: true,
      })),
      ...(primary
        ? {
            primaryMarket: primary.marketAddress,
            market: primary.marketAddress,
            label: primary.label,
            marketKind: primary.marketKind,
            baseMint: primary.baseMint,
            quoteMint: primary.quoteMint,
            baseDecimals: primary.baseDecimals,
            quoteDecimals: primary.quoteDecimals,
            baseTokenProgram: primary.baseTokenProgram,
            quoteTokenProgram: primary.quoteTokenProgram,
            ylpMint: primary.ylpMint,
            baseHlpMint: primary.baseHlpMint,
            quoteHlpMint: primary.quoteHlpMint,
            seededLiquidity: true,
            transferHookValidationAccounts: {
              ylp: primary.ylpMint,
              baseHlp: primary.baseHlpMint,
              quoteHlp: primary.quoteHlpMint,
            },
          }
        : {}),
      parameterTimelockSeconds: '0',
      parameterExecutionWindowSeconds: '0',
    },
  };
}

type DeploymentSnapshot = Awaited<ReturnType<typeof deploymentPayload>>;

/** Coalesce concurrent requests; never keep a fully assembled live surface. */
export async function deploymentSnapshot(
  deployment: DuskDeploymentEnvelope,
): Promise<DeploymentSnapshot> {
  return cache.getOrSet(
    `dusk:deployment_surface:${deployment.deploymentIdentitySha256}`,
    0,
    () => deploymentPayload(deployment),
  );
}
