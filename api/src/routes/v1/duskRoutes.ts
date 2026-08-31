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
