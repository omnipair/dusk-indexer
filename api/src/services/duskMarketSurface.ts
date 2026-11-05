import { duskApiConfig, loadPinnedProtocol } from '../config/duskProtocol';
import { DuskDeploymentEnvelope } from './duskDeploymentService';
import { discoverMarkets, marketPayload, marketPayloadSourceSlot } from './duskMarketService';
import { marketCreations, withMarketCreation } from './duskReadModel';
import { cache } from '../utils/cache';

/**
 * The deployment's market surface, as the read boundary expects it: the
 * configuration describes the primary market and lists every market, and the
 * list endpoint returns all of them in one page.
 */
async function deploymentPayload(deployment: DuskDeploymentEnvelope) {
  const pinned = loadPinnedProtocol();
  const config = duskApiConfig();
  const { markets, sourceSlot } = await discoverMarkets();
  const [payloads, creations] = await Promise.all([
    Promise.all(
      markets.map((market) =>
        marketPayload(market.address, market.account, sourceSlot, deployment),
      ),
    ),
    marketCreations(
      pinned.cluster,
      markets.map((market) => market.address.toBase58()),
    ),
  ]);
  const projected = payloads.map((payload) =>
    withMarketCreation(payload, creations.get(String(payload.marketAddress))),
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

  const observedSlot = projected.reduce(
    (highest, market) => Math.max(highest, marketPayloadSourceSlot(market)),
    sourceSlot,
  );

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
        srlpMint: market.srlpMint,
        juniorMint: market.juniorMint,
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
            srlpMint: primary.srlpMint,
            juniorMint: primary.juniorMint,
            baseHlpMint: primary.baseHlpMint,
            quoteHlpMint: primary.quoteHlpMint,
            seededLiquidity: true,
            transferHookValidationAccounts: {
              srlp: primary.srlpMint,
              junior: primary.juniorMint,
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

export interface MarketPreviewStatus {
  /** Markets the surface carries. */
  total: number;
  /** Each market whose `previewMarket` failed, with the reason it reports. */
  failing: { market: string; label: string; reason: string | null; errorName: string | null }[];
  /** Why the surface itself could not be read, if it could not. */
  error: string | null;
}

/** The markets whose preview failed, from projected market payloads. */
export function failingMarketPreviews(projected: Record<string, unknown>[]): MarketPreviewStatus['failing'] {
  return projected.flatMap((market) => {
    const state = market.state as { previewStatus?: unknown; previewFailure?: { reason?: unknown; errorName?: unknown } | null } | undefined;
    if (state?.previewStatus !== 'unavailable') return [];
    const failure = state.previewFailure;
    return [{
      market: String(market.marketAddress),
      label: String(market.label),
      reason: typeof failure?.reason === 'string' ? failure.reason : null,
      errorName: typeof failure?.errorName === 'string' ? failure.errorName : null,
    }];
  });
}

/** What `/status` reports about market previews, read from the same surface
 * `/markets/state` serves. A failed read is reported, never thrown. */
export async function marketPreviewStatus(deployment: DuskDeploymentEnvelope,
  read: typeof deploymentSnapshot = deploymentSnapshot): Promise<MarketPreviewStatus> {
  try {
    const { projected } = await read(deployment);
    return { total: projected.length,failing: failingMarketPreviews(projected),error: null };
  } catch (error) {
    return { total: 0,failing: [],error: error instanceof Error ? error.message : String(error) };
  }
}
