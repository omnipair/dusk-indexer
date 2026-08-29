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
  boundedLimit,
  boundedOffset,
  ingestionHealth,
  listEvents,
  listMarkets,
  marketDetail,
} from '../../services/duskReadModel';

const router = Router();

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
 * Compatibility surface for clients written against the fork lab's
 * `/api/v2/fork/config`. The path names a fork because that is where it came
 * from; the payload is this deployment's identity. New clients should read
 * `/api/dusk/v1/deployment`, which is the same envelope under an honest name.
 */
export const forkCompatRouter = Router();

forkCompatRouter.get(
  '/config',
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
