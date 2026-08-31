/**
 * Dusk read API.
 *
 * Every response carries the deployment envelope, so a client that was built
 * against a different program refuses the payload instead of rendering it.
 */

import { Router } from 'express';

import { duskApiConfig, loadPinnedProtocol } from '../../config/duskProtocol';
import {
  deploymentEnvelope,
  withDeployment,
} from '../../services/duskDeploymentService';
import {
  discoverMarkets,
  fetchMarket,
  marketPayload,
} from '../../services/duskMarketService';
import {
  boundedLimit,
  boundedOffset,
  ingestionHealth,
  listEvents,
  listMarkets,
  marketDetail,
} from '../../services/duskReadModel';

import { PublicKey } from '@solana/web3.js';

const router = Router();

/**
 * The deployment's market surface, as the read boundary expects it: the
 * configuration describes the primary market and lists every market, and the
 * list endpoint returns all of them in one page.
 */
async function deploymentPayload() {
  const pinned = loadPinnedProtocol();
  const config = duskApiConfig();
  const { markets, sourceSlot } = await discoverMarkets();
  const projected = await Promise.all(
    markets.map((market) =>
      marketPayload(market.address, market.account, sourceSlot),
    ),
  );
  const primary = projected[0];

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
      rpcUrl: config.rpcUrl,
      programId: pinned.dusk.programId,
      leverageDelegateProgramId: pinned.leverageDelegate.programId,
      payer: (await deploymentEnvelope()).programUpgradeAuthority,
      fixtureMode: 'mainnet',
      markets: projected.map((market) => ({
        label: market.label,
        market: market.marketAddress,
        marketKind: market.marketKind,
        baseMint: market.baseMint,
        quoteMint: market.quoteMint,
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
let snapshot: { value: DeploymentSnapshot; atMs: number } | undefined;
let snapshotInflight: Promise<DeploymentSnapshot> | undefined;

function snapshotTtlMs(): number {
  const raw = process.env.DUSK_MARKET_CACHE_TTL_MS?.trim();
  const parsed = raw ? Number(raw) : 10_000;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 10_000;
}

async function deploymentSnapshot(): Promise<DeploymentSnapshot> {
  if (snapshot && Date.now() - snapshot.atMs < snapshotTtlMs()) {
    return snapshot.value;
  }
  if (!snapshotInflight) {
    snapshotInflight = deploymentPayload()
      .then((value) => {
        snapshot = { value, atMs: Date.now() };
        return value;
      })
      .finally(() => {
        snapshotInflight = undefined;
      });
  }
  return snapshotInflight;
}

function cluster(): string {
  return duskApiConfig().network;
}

function asyncRoute(
  handler: (
    req: Parameters<Parameters<Router['get']>[1]>[0],
    res: Parameters<Parameters<Router['get']>[1]>[1],
  ) => Promise<unknown>,
) {
  return (
    req: Parameters<Parameters<Router['get']>[1]>[0],
    res: Parameters<Parameters<Router['get']>[1]>[1],
    next: Parameters<Parameters<Router['get']>[1]>[2],
  ) => {
    handler(req, res).catch(next);
  };
}

/** The deployment identity on its own, plus what this API is pinned to. */
router.get(
  '/deployment',
  asyncRoute(async (_req, res) => {
    const pinned = loadPinnedProtocol();
    const config = duskApiConfig();
    res.json(
      await withDeployment({
        network: config.network,
        protocolRevision: pinned.revision,
        rpcUrl: config.rpcUrl,
        programs: {
          dusk: pinned.dusk.programId,
          leverageDelegate: pinned.leverageDelegate.programId,
        },
      }),
    );
  }),
);

router.get(
  '/config',
  asyncRoute(async (_req, res) => {
    const { config, sourceSlot } = await deploymentSnapshot();
    res.json(await withDeployment(config, sourceSlot));
  }),
);

router.get(
  '/markets/state/:market',
  asyncRoute(async (req, res) => {
    let address: PublicKey;
    try {
      address = new PublicKey(req.params.market);
    } catch {
      res.status(400).json({ success: false, error: 'invalid market address' });
      return;
    }
    const { account, sourceSlot } = await fetchMarket(address);
    const payload = await marketPayload(address, account, sourceSlot);
    const state = payload.state as Record<string, unknown>;
    res.json(
      await withDeployment(
        payload,
        Math.max(sourceSlot, Number(state.healthSourceSlot ?? 0)),
      ),
    );
  }),
);

router.get(
  '/markets/state',
  asyncRoute(async (_req, res) => {
    const { projected, sourceSlot } = await deploymentSnapshot();
    res.json(
      await withDeployment(
        {
          markets: projected,
          pagination: { limit: 100, offset: 0, total: projected.length },
        },
        sourceSlot,
      ),
    );
  }),
);

router.get(
  '/markets',
  asyncRoute(async (req, res) => {
    const limit = boundedLimit(req.query.limit);
    const offset = boundedOffset(req.query.offset);
    res.json(await withDeployment(await listMarkets(cluster(), limit, offset)));
  }),
);

router.get(
  '/markets/:market',
  asyncRoute(async (req, res) => {
    const detail = await marketDetail(cluster(), req.params.market);
    if (!detail) {
      res.status(404).json({
        success: false,
        error: `No indexed activity for market ${req.params.market}`,
      });
      return;
    }
    res.json(await withDeployment(detail));
  }),
);

router.get(
  '/markets/:market/events',
  asyncRoute(async (req, res) => {
    const events = await listEvents(cluster(), {
      market: req.params.market,
      eventNames: parseEventNames(req.query.events),
      since: parseTimestamp(req.query.since),
      until: parseTimestamp(req.query.until),
      limit: boundedLimit(req.query.limit),
      offset: boundedOffset(req.query.offset),
    });
    res.json(await withDeployment(events));
  }),
);

/** Global activity feed across every indexed market. */
router.get(
  '/events',
  asyncRoute(async (req, res) => {
    const events = await listEvents(cluster(), {
      market: typeof req.query.market === 'string' ? req.query.market : undefined,
      eventNames: parseEventNames(req.query.events),
      since: parseTimestamp(req.query.since),
      until: parseTimestamp(req.query.until),
      limit: boundedLimit(req.query.limit),
      offset: boundedOffset(req.query.offset),
    });
    res.json(await withDeployment(events));
  }),
);

/**
 * Ingestion health. Deliberately does not carry the envelope: it must stay
 * answerable when chain observation is the thing that is broken.
 */
router.get(
  '/health',
  asyncRoute(async (_req, res) => {
    const health = await ingestionHealth(cluster());
    let deployment: string | null = null;
    let deploymentError: string | null = null;
    try {
      deployment = (await deploymentEnvelope()).deploymentIdentitySha256;
    } catch (error) {
      deploymentError = error instanceof Error ? error.message : String(error);
    }
    res.status(deploymentError ? 503 : 200).json({
      success: !deploymentError,
      data: {
        ...health,
        protocolRevision: loadPinnedProtocol().revision,
        deploymentIdentitySha256: deployment,
        deploymentError,
      },
    });
  }),
);

/**
 * Operational status, for a person rather than a client.
 *
 * Health answers "is ingestion working"; this answers "what is this
 * deployment and how far behind is it", which is what someone asks when the
 * app looks wrong. Degradation is named rather than implied by a status code,
 * because a reader needs to know which part is behind.
 */
router.get(
  '/status',
  asyncRoute(async (_req, res) => {
    const pinned = loadPinnedProtocol();
    const config = duskApiConfig();
    const health = await ingestionHealth(cluster());

    let chainSlot: number | null = null;
    let identity: string | null = null;
    let identityError: string | null = null;
    try {
      const envelope = await deploymentEnvelope();
      chainSlot = envelope.sourceSlot;
      identity = envelope.deploymentIdentitySha256;
    } catch (error) {
      identityError = error instanceof Error ? error.message : String(error);
    }

    const indexedSlot = health.latestSlot ? Number(health.latestSlot) : null;
    // Slot lag is the honest measure of staleness: a timestamp says when the
    // last event happened, not how far behind the indexer is.
    const slotLag =
      chainSlot !== null && indexedSlot !== null
        ? Math.max(0, chainSlot - indexedSlot)
        : null;

    const degraded: string[] = [];
    if (identityError) degraded.push('deployment-identity');
    if (health.cursor === null) degraded.push('ingestion-cursor');
    if (slotLag !== null && slotLag > 15_000) degraded.push('indexer-lag');

    res.status(degraded.length > 0 ? 503 : 200).json({
      success: degraded.length === 0,
      data: {
        cluster: config.network,
        protocolRevision: pinned.revision,
        programs: {
          dusk: pinned.dusk.programId,
          leverageDelegate: pinned.leverageDelegate.programId,
        },
        deploymentIdentitySha256: identity,
        deploymentError: identityError,
        chainSlot,
        indexedSlot,
        slotLag,
        indexedEvents: health.eventCount,
        indexedMarkets: health.marketCount,
        latestEventAt: health.latestEventAt,
        degraded,
      },
    });
  }),
);

function parseEventNames(raw: unknown): string[] | undefined {
  if (typeof raw !== 'string' || raw.trim() === '') return undefined;
  const names = raw
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  return names.length ? names : undefined;
}

function parseTimestamp(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.trim() === '') return undefined;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return parsed.toISOString();
}

export default router;
