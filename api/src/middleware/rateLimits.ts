import type { Request } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';

function positiveLimit(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(parsed)) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

// Express resolves the client through the configured trusted proxy chain.
// A caller-supplied Cloudflare header must not create a fresh rate-limit key.
export const apiRateLimitKey = (req: Request): string =>
  ipKeyGenerator(req.ip || req.socket.remoteAddress || 'unknown');

const identityRead = (req: Request): boolean =>
  (req.method === 'GET' || req.method === 'HEAD') &&
  /^\/api\/dusk\/v1\/deployment\/?$/.test(req.path);

export function createApiRateLimits(env: NodeJS.ProcessEnv = process.env) {
  const shared = {
    windowMs: 60 * 1000,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: apiRateLimitKey,
    message: { success: false, error: 'Too many requests, please try again later.' },
  };
  // A trading session revalidates several active read families on 2s pushes,
  // with two fresh identity checks per read (including RPC-only previews).
  // Allow two full trading sessions behind one IP plus startup/recovery bursts.
  // These are still bounded per-client budgets, independently configurable;
  // identity checks must not consume the financial-data allowance.
  return [
    rateLimit({ ...shared,
      limit: positiveLimit(env.RATE_LIMIT_MAX, 1200, 'RATE_LIMIT_MAX'),
      skip: identityRead,
    }),
    rateLimit({ ...shared,
      limit: positiveLimit(env.RATE_LIMIT_IDENTITY_MAX, 3600, 'RATE_LIMIT_IDENTITY_MAX'),
      skip: (req) => !identityRead(req),
    }),
  ];
}
