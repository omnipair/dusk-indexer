/**
 * Dusk read API.
 *
 * Every response carries the deployment envelope, so a client that was built
 * against a different program refuses the payload instead of rendering it.
 */

import { Router } from 'express';

import { duskApiConfig, loadPinnedProtocol } from '../../config/duskProtocol';
import {
  DuskDeploymentEnvelope,
  deploymentEnvelope,
  withDeployment,
  withDeploymentRead,
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

import { cache } from '../../utils/cache';
import { listNativeAccounts, NativeAccountKind } from '../../services/duskNativeAccounts';
import { listDuskLpOwnership } from '../../services/duskLpOwnership';
import { listYieldClaims } from '../../services/duskYieldClaims';
import { listYieldCheckpoints } from '../../services/duskYieldCheckpoints';
import { listDuskPriceHistory } from '../../services/duskPrices';
import { listYieldRates } from '../../services/duskYieldRates';
import { listMarketActivity } from '../../services/duskMarketActivity';
import { listOrderHistory } from '../../services/duskOrderHistory';
import { listEventHistory } from '../../services/duskEventHistory';
import { clearQuoteHistoryCache, listQuoteHistory } from '../../services/duskQuoteHistory';
import { listArchivedQuoteHistory } from '../../services/duskArchivedQuoteHistory';
import { openDuskChangeStream } from '../../services/duskChangeStream';
import { listPortfolioHistory, portfolioSampleSeconds } from '../../services/duskPortfolioSnapshots';
import { provenance, renderMetrics } from '../../utils/metrics';

import { PublicKey } from '@solana/web3.js';

const router = Router();

router.get('/changes', asyncRoute(openDuskChangeStream));

router.get('/history/quotes/:market', asyncRoute(async (req,res) => {
  const parameter = (name: string, fallback?: string) => {
    const value = req.query[name] ?? fallback;
    if (typeof value !== 'string') throw Object.assign(new Error(`Invalid ${name}`),{ status: 400 });
    return value;
  };
  const side = parameter('side','base');
  if (side !== 'base' && side !== 'quote') throw Object.assign(new Error('Invalid quote side'),{ status: 400 });
  const selection = { market: req.params.market,side,since: parameter('since'),until: parameter('until',new Date().toISOString()),
    resolutionSeconds: Number(parameter('resolutionSeconds','60')) };
  const refresh = req.query.afterRevision === undefined && req.query.afterUntil === undefined ? undefined
    : { afterRevision:parameter('afterRevision'),afterUntil:parameter('afterUntil') };
  try {
    res.json(await withDeploymentRead<unknown>(async deployment => {
      if (req.query.archivedRevision !== undefined) {
        if (refresh) throw Object.assign(new Error('Archive reads do not accept a live cursor'),{status:400});
        const data = await listArchivedQuoteHistory({...selection,side,deployment,deploymentIdentitySha256:deployment.deploymentIdentitySha256},parameter('archivedRevision'));
        return {data,sourceSlot:Number(data.history.coverage.lastSourceSlot ?? 0)};
      }
      const data = await listQuoteHistory({ ...selection,side,deployment,deploymentIdentitySha256: deployment.deploymentIdentitySha256 },refresh);
      const history = 'history' in data ? data.history : data;
      const sourceSlot = Number(history.coverage.lastSourceSlot ?? 0);
      if (!Number.isSafeInteger(sourceSlot)) throw new Error('Invalid quote-history source slot');
      return { data,sourceSlot };
    }));
  } catch (error) { clearQuoteHistoryCache(); throw error; }
}));

router.get('/history/orders', asyncRoute(async (req,res) => {
  const parameter = (name: string, fallback?: string) => {
    const value=req.query[name]??fallback;
    if(value!==undefined&&typeof value!=='string') throw Object.assign(new Error(`Invalid ${name}`),{status:400});
    return value as string | undefined;
  };
  const owner=parameter('owner');
  if(!owner) throw Object.assign(new Error('Order history requires an owner'),{status:400});
  res.json(await withDeploymentRead(async deployment => {
    const data=await listOrderHistory({owner,market:parameter('market'),until:parameter('until',new Date().toISOString())!,limit:Number(parameter('limit','50')),cursor:parameter('cursor'),deploymentIdentitySha256:deployment.deploymentIdentitySha256});
    const sourceSlot=Math.max(Number(data.coverage.throughSlot),...data.orders.map(row=>Number(row.slot)));
    if(!Number.isSafeInteger(sourceSlot)) throw new Error('Invalid order history slot');
    return {data,sourceSlot};
  }));
}));

router.get('/history/events', asyncRoute(async (req, res) => {
  const stringParameter = (name: string) => {
    const value = req.query[name];
    if (value !== undefined && typeof value !== 'string')
      throw Object.assign(new Error(`Invalid ${name}`), { status: 400 });
    return value as string | undefined;
  };
  const until = stringParameter('until') ?? new Date().toISOString();
  const version = stringParameter('version') ?? '1';
  if (version !== '1' && version !== '2')
    throw Object.assign(new Error('Invalid event history version'), {status:400});
  const limit = req.query.limit === undefined ? 100 : Number(stringParameter('limit'));
  const category = stringParameter('category');
  if (category !== undefined && category !== 'leverage-close' && category !== 'activity')
    throw Object.assign(new Error('Invalid event history category'), {status:400});
  res.json(await withDeploymentRead(async deployment => {
    const data = await listEventHistory({ market: stringParameter('market'), since: stringParameter('since'), until,
      owner: stringParameter('owner'), category, version: version === '2' ? 2 : 1,
      cursor: stringParameter('cursor'), limit, deploymentIdentitySha256: deployment.deploymentIdentitySha256 });
    const sourceSlot = data.events.reduce((highest, row) => Math.max(highest, Number(row.slot)), 0);
    if (!Number.isSafeInteger(sourceSlot)) throw new Error('Invalid event-history source slot');
    return { data, sourceSlot };
  }));
}));

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
    ? projected.find((market) => String(market.marketAddress) === config.primaryMarket)
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
async function deploymentSnapshot(deployment: DuskDeploymentEnvelope): Promise<DeploymentSnapshot> {
  return cache.getOrSet(`dusk:deployment_surface:${deployment.deploymentIdentitySha256}`, 0, () =>
    deploymentPayload(deployment),
  );
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
    res.json(await withDeploymentRead(async (deployment) => {
      const { config, sourceSlot } = await deploymentSnapshot(deployment);
      return { data: config, sourceSlot };
    }));
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
    res.json(await withDeploymentRead(async (deployment) => {
      const { account, sourceSlot } = await fetchMarket(address);
      const payload = await marketPayload(address, account, sourceSlot, deployment.deploymentIdentitySha256);
      const state = payload.state as Record<string, unknown>;
      return { data: payload, sourceSlot: Math.max(sourceSlot, Number(state.healthSourceSlot ?? 0)) };
    }));
  }),
);

router.get(
  '/markets/state',
  asyncRoute(async (_req, res) => {
    res.json(await withDeploymentRead(async (deployment) => {
      const { config, projected, sourceSlot } = await deploymentSnapshot(deployment);
      // Inventory and its configuration come from this exact snapshot. Clients
      // need one data request and validate both under the same final envelope.
      return { data: { configuration: config, markets: projected, pagination: { limit: Math.max(100, projected.length), offset: 0, total: projected.length } }, sourceSlot };
    }));
  }),
);

router.get('/analytics/yield-rates',asyncRoute(async (req,res) => {
  const parameter = (name: string,fallback?: string) => {
    const value = req.query[name] ?? fallback;
    if (typeof value !== 'string' || !value.trim()) throw Object.assign(new Error(`Invalid ${name}`),{ status: 400 });
    return value;
  };
  const since = parameter('since'),until = parameter('until',new Date().toISOString());
  let market: string | undefined;
  if (req.query.market !== undefined) {
    try { market = new PublicKey(parameter('market')).toBase58(); }
    catch { throw Object.assign(new Error('Invalid yield market'),{ status: 400 }); }
  }
  res.json(await withDeploymentRead(async deployment => {
    const data = await listYieldRates({ since,until,market,deployment,deploymentIdentitySha256: deployment.deploymentIdentitySha256 });
    return { data,sourceSlot: data.coverage.sourceSlot };
  }));
}));

router.get('/analytics/activity',asyncRoute(async (req,res) => {
  const timestamp = (value: unknown): string | undefined => {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || !value.trim() || !Number.isFinite(Date.parse(value)) || Date.parse(value)>Date.now())
      throw Object.assign(new Error('Invalid activity timestamp'),{ status: 400 });
    return new Date(value).toISOString();
  };
  const since = timestamp(req.query.since),until = timestamp(req.query.until) ?? new Date().toISOString();
  let market: string | undefined;
  if (req.query.market !== undefined) {
    try {
      if (typeof req.query.market !== 'string') throw new Error('Invalid market');
      market = new PublicKey(req.query.market).toBase58();
      if (market !== req.query.market) throw new Error('Invalid market');
    }
    catch { throw Object.assign(new Error('Invalid activity market'),{ status: 400 }); }
  }
  const maxPriceAgeSeconds = req.query.maxPriceAgeSeconds === undefined ? 3600 : Number(req.query.maxPriceAgeSeconds);
  if (since && since>until || req.query.maxPriceAgeSeconds !== undefined &&
    (typeof req.query.maxPriceAgeSeconds !== 'string' || !/^[1-9]\d*$/.test(req.query.maxPriceAgeSeconds))
    || !Number.isSafeInteger(maxPriceAgeSeconds) || maxPriceAgeSeconds<1 || maxPriceAgeSeconds>86400)
    throw Object.assign(new Error('Invalid activity time range'),{ status: 400 });
  res.json(await withDeploymentRead(async (deployment) => {
    const data = await listMarketActivity({ since,until,market,maxPriceAgeSeconds,deployment,deploymentIdentitySha256: deployment.deploymentIdentitySha256 });
    const sourceSlot = Math.max(Number(data.coverage.lastSourceSlot ?? 0),Number(data.coverage.historyScan?.throughSlot ?? 0));
    if (!Number.isSafeInteger(sourceSlot) || sourceSlot<0) throw new Error('Invalid activity source slot');
    return { data,sourceSlot };
  }));
}));

router.get('/prices/:mint',asyncRoute(async (req,res) => {
  let mint: string,market: string | undefined;
  try {
    mint = new PublicKey(req.params.mint).toBase58();
    market = req.query.market === undefined ? undefined : new PublicKey(String(req.query.market)).toBase58();
  } catch { res.status(400).json({ success: false,error: 'invalid mint or market address' }); return; }
  const at = req.query.at === undefined ? new Date().toISOString() : String(req.query.at);
  const maxAgeSeconds = req.query.maxAgeSeconds === undefined ? 3600 : Number(req.query.maxAgeSeconds);
  if (!Number.isFinite(Date.parse(at)) || Date.parse(at)>Date.now() || !Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds<1 || maxAgeSeconds>86400) {
    res.status(400).json({ success: false,error: 'invalid historical price time range' }); return;
  }
  res.json(await withDeploymentRead(async () => {
    const data = await listDuskPriceHistory({ mint,market,at,maxAgeSeconds,limit: boundedLimit(req.query.limit),offset: boundedOffset(req.query.offset) });
    const sourceSlot = data.observations.reduce((highest,row) => Math.max(highest,Number(row.evidence.sourceSlot)),0);
    return { data,sourceSlot };
  }));
}));

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

/** Native account discovery with independent identity and scan provenance. */
router.get('/accounts/:kind', asyncRoute(async (req, res) => {
  const kind = req.params.kind as NativeAccountKind;
  if (!['markets','borrow','leverage','yield','orders'].includes(kind)) {
    res.status(400).json({ success: false, error: 'Unsupported native account kind' }); return;
  }
  const address = (value: unknown) => {
    if (value === undefined) return undefined;
    try { if (typeof value === 'string') return new PublicKey(value).toBase58(); } catch { /* handled below */ }
    throw Object.assign(new Error('Invalid native account filter address'), { status: 400 });
  };
  const owner = address(req.query.owner), market = address(req.query.market);
  res.json(await withDeploymentRead(async () => {
    const result = await listNativeAccounts({ cluster: cluster(), kind, owner, market, limit: boundedLimit(req.query.limit), offset: boundedOffset(req.query.offset) });
    return { data: result, sourceSlot: Number(result.coverage.sourceSlot) };
  }));
}));

router.get('/lp-ownership', asyncRoute(async (req, res) => {
  const address = (value: unknown) => {
    if (value === undefined) return undefined;
    try { if (typeof value === 'string') return new PublicKey(value).toBase58(); } catch { /* handled below */ }
    throw Object.assign(new Error('Invalid LP ownership filter address'), { status: 400 });
  };
  const owner = address(req.query.owner), market = address(req.query.market);
  res.json(await withDeploymentRead(async () => {
    const result = await listDuskLpOwnership({ owner, market, limit: boundedLimit(req.query.limit), offset: boundedOffset(req.query.offset) });
    const { envelopeSourceSlot, ...data } = result;
    return { data, sourceSlot: envelopeSourceSlot };
  }));
}));

/** Saved native position values, with catalog and per-bank coverage. */
router.get('/owners/:owner/portfolio-snapshots',asyncRoute(async (req,res) => {
  let owner: string;
  try { owner = new PublicKey(req.params.owner).toBase58(); }
  catch { res.status(400).json({ success: false,error: 'invalid portfolio owner address' }); return; }
  const timestamp = (value: unknown): string | undefined => {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || !value.trim() || !Number.isFinite(Date.parse(value)) || Date.parse(value)>Date.now())
      throw Object.assign(new Error('Invalid portfolio history time'),{ status: 400 });
    return new Date(value).toISOString();
  };
  const since = timestamp(req.query.since),until = timestamp(req.query.until);
  const sampleSeconds = portfolioSampleSeconds(req.query.sampleSeconds);
  if (since && until && since>until) throw Object.assign(new Error('Portfolio history start is after its end'),{ status: 400 });
  res.json(await withDeploymentRead(async () => {
    const data = await listPortfolioHistory({ owner,since,until,sampleSeconds,limit: boundedLimit(req.query.limit),offset: boundedOffset(req.query.offset) });
    const sourceSlot = Number(data.coverage.lastSourceSlot ?? 0);
    if (!Number.isSafeInteger(sourceSlot) || sourceSlot<0) throw new Error('Invalid portfolio history slot');
    return { data,sourceSlot };
  }));
}));

/** Coherent observations of recorded yield; these are not harvest previews. */
router.get('/owners/:owner/yield-checkpoints', asyncRoute(async (req, res) => {
  const address = (value: unknown): string => {
    try { if (typeof value === 'string' && new PublicKey(value).toBase58() === value) return value; } catch { /* invalid below */ }
    throw Object.assign(new Error('Invalid yield checkpoint address'),{ status: 400 });
  };
  const owner = address(req.params.owner),market = req.query.market === undefined ? undefined : address(req.query.market);
  res.json(await withDeploymentRead(async () => {
    const data = await listYieldCheckpoints({ owner,market,limit: boundedLimit(req.query.limit),offset: boundedOffset(req.query.offset) });
    const sourceSlot = Number(data.coverage.lastSourceSlot ?? 0);
    if (!Number.isSafeInteger(sourceSlot) || sourceSlot<0) throw new Error('Invalid yield checkpoint slot');
    return { data,sourceSlot };
  }));
}));

/** Finalized payments attributed to the earning owner, with the recipient retained. */
router.get('/owners/:owner/yield-claims', asyncRoute(async (req, res) => {
  const address = (value: unknown): string => {
    try { if (typeof value === 'string' && new PublicKey(value).toBase58() === value) return value; } catch { /* invalid below */ }
    throw Object.assign(new Error('Invalid yield history address'), { status: 400 });
  };
  const timestamp = (value: unknown): string | undefined => {
    if (value === undefined) return undefined;
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
    throw Object.assign(new Error('Invalid yield history timestamp'), { status: 400 });
  };
  const owner = address(req.params.owner), market = req.query.market === undefined ? undefined : address(req.query.market);
  const since = timestamp(req.query.since), until = timestamp(req.query.until);
  if (since && until && Date.parse(since) > Date.parse(until))
    throw Object.assign(new Error('Yield history start is after its end'), { status: 400 });
  res.json(await withDeploymentRead(async () => {
    const data = await listYieldClaims({ owner, market, since, until, limit: boundedLimit(req.query.limit), offset: boundedOffset(req.query.offset) });
    const sourceSlot = Number(data.coverage.lastIndexedSlot ?? 0);
    if (!Number.isSafeInteger(sourceSlot) || sourceSlot < 0) throw new Error('Invalid yield history source slot');
    return { data, sourceSlot };
  }));
}));

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
    const slotLag =
      chainSlot !== null && indexedSlot !== null
        ? Math.max(0, chainSlot - indexedSlot)
        : null;

    // Slot lag measures how recently something *happened*, not whether the
    // daemon is working: on a quiet market it grows without bound while
    // ingestion is perfectly healthy. The daemon touches its cursor on every
    // poll, so the cursor's age is what separates a quiet market from a dead
    // ingester — and it is the age, not the lag, that decides degradation.
    const cursorUpdatedAt = health.cursor?.updatedAt ?? null;
    const cursorAgeSeconds = cursorUpdatedAt
      ? Math.max(0, Math.round((Date.now() - Date.parse(cursorUpdatedAt)) / 1000))
      : null;
    const staleAfterSeconds = Number(process.env.DUSK_CURSOR_STALE_SECONDS ?? 300);

    const degraded: string[] = [];
    if (identityError) degraded.push('deployment-identity');
    if (health.cursor === null) degraded.push('ingestion-cursor');
    if (cursorAgeSeconds !== null && cursorAgeSeconds > staleAfterSeconds) {
      degraded.push('ingestion-stalled');
    }

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
        cursorUpdatedAt,
        cursorAgeSeconds,
        indexedEvents: health.eventCount,
        indexedMarkets: health.marketCount,
        latestEventAt: health.latestEventAt,
        degraded,
      },
    });
  }),
);

/**
 * Metrics, in the text exposition format any scraper understands.
 *
 * Carries the protocol revision and deployment identity as labels rather than
 * as a separate endpoint: a scrape that cannot say which deployment produced
 * it is impossible to reconcile after a redeploy, which is exactly when the
 * numbers matter.
 */
router.get(
  '/metrics',
  asyncRoute(async (_req, res) => {
    const pinned = loadPinnedProtocol();
    let identity = 'unavailable';
    try {
      identity = (await deploymentEnvelope()).deploymentIdentitySha256;
    } catch {
      // Chain observation is allowed to be down without taking metrics with
      // it — a scrape is most valuable when something is broken.
    }
    res.type('text/plain; version=0.0.4').send(
      renderMetrics({
        cluster: duskApiConfig().network,
        deployment: identity,
        revision: pinned.revision,
      }),
    );
  }),
);

/** Build and protocol provenance for this process. */
router.get(
  '/provenance',
  asyncRoute(async (_req, res) => {
    let identity: string | null = null;
    try {
      identity = (await deploymentEnvelope()).deploymentIdentitySha256;
    } catch {
      identity = null;
    }
    res.json({
      success: true,
      data: provenance(loadPinnedProtocol().revision, identity),
    });
  }),
);

/**
 * Status page.
 *
 * The JSON at `/status` is for a client; this is for a person who has been
 * told the app is broken and needs to know, in one glance, whether it is the
 * chain, the indexer, or something else. It polls itself so a tab left open
 * stays true, and it names the runbook for whatever is degraded rather than
 * leaving the reader to guess which one applies.
 *
 * The script is a separate route rather than inline because the API sets a
 * strict `script-src 'self'` and an inline block is silently dropped — the
 * page renders, never updates, and looks like a broken endpoint. Serving it
 * as a file satisfies the policy instead of weakening it for every route.
 *
 * Keeper liveness is reported by the keepers' own endpoints rather than
 * proxied through here: this service cannot vouch for a process it does not
 * run, and a status page that invents green is worse than none.
 */
router.get('/status/page', (_req, res) => {
  const config = duskApiConfig();
  res.type('html').send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Dusk ${config.network} status</title>
<style>
  :root { color-scheme: light dark; --ok: #1a7f37; --bad: #b3261e; --muted: #6b7280; }
  body { font: 15px/1.5 ui-sans-serif, system-ui, sans-serif; margin: 0; padding: 2rem 1.25rem; max-width: 46rem; margin-inline: auto; }
  h1 { font-size: 1.1rem; margin: 0 0 .25rem; }
  .sub { color: var(--muted); margin: 0 0 1.5rem; font-size: .875rem; }
  .state { font-size: 1.5rem; font-weight: 600; margin: 0 0 1rem; }
  .ok { color: var(--ok); } .bad { color: var(--bad); }
  table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; }
  th, td { text-align: left; padding: .4rem .5rem .4rem 0; border-bottom: 1px solid color-mix(in srgb, currentColor 12%, transparent); }
  th { font-weight: 500; color: var(--muted); width: 12rem; }
  code { font-family: ui-monospace, monospace; font-size: .85em; word-break: break-all; }
</style>
</head>
<body>
<h1>Dusk &middot; ${config.network}</h1>
<p class="sub">Refreshes every 15 seconds. Reported by the API itself; keeper
liveness is on each keeper's own <code>/readyz</code>.</p>
<p class="state" id="state">checking&hellip;</p>
<table id="rows"></table>
<div id="degraded"></div>
<script src="page.js"></script>
</body>
</html>`);
});

/** The status page's script. See `/status/page` for why it is not inline. */
router.get('/status/page.js', (_req, res) => {
  res.type('application/javascript').send(`
const RUNBOOKS = {
  'deployment-identity': 'rpc-provider-outage',
  'ingestion-cursor': 'database-unavailable',
  'indexer-lag': 'indexer-lag',
  'ingestion-stalled': 'indexer-lag',
};
const RUNBOOK_BASE =
  'https://github.com/omnipair/dusk-indexer/blob/main/docs/runbooks/';

function row(label, value) {
  return '<tr><th>' + label + '</th><td>' + value + '</td></tr>';
}

async function refresh() {
  const state = document.getElementById('state');
  try {
    const response = await fetch('../status', { cache: 'no-store' });
    const body = await response.json();
    const data = body.data;
    const degraded = data.degraded || [];
    state.textContent = degraded.length === 0 ? 'Operational' : 'Degraded';
    state.className = 'state ' + (degraded.length === 0 ? 'ok' : 'bad');
    document.getElementById('rows').innerHTML = [
      row('Cluster', data.cluster),
      row('Protocol revision', '<code>' + data.protocolRevision + '</code>'),
      row('Deployment identity', '<code>' + (data.deploymentIdentitySha256 || 'unavailable') + '</code>'),
      row('Chain slot', data.chainSlot === null ? '—' : data.chainSlot),
      row('Indexed slot', data.indexedSlot === null ? '—' : data.indexedSlot),
      row('Slot lag', data.slotLag === null ? '—' : data.slotLag),
      row('Cursor age', data.cursorAgeSeconds === null ? '—' : data.cursorAgeSeconds + 's'),
      row('Indexed events', data.indexedEvents),
      row('Indexed markets', data.indexedMarkets),
      row('Latest event', data.latestEventAt || '—')
    ].join('');
    document.getElementById('degraded').innerHTML =
      degraded.length === 0
        ? ''
        : '<p>Degraded: ' + degraded.map(function (name) {
            const book = RUNBOOKS[name];
            return book
              ? '<a href="' + RUNBOOK_BASE + book + '.md"><code>' + name + '</code></a>'
              : '<code>' + name + '</code>';
          }).join(', ') + '</p>';
  } catch (error) {
    // A page that cannot reach its own API is itself the signal, so it says
    // so rather than leaving the last good reading on screen.
    state.textContent = 'API unreachable';
    state.className = 'state bad';
    document.getElementById('degraded').innerHTML =
      '<p><code>' + String(error) + '</code></p>';
  }
}

refresh();
setInterval(refresh, 15000);
`);
});

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
