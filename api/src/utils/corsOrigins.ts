import { allowsPreviewOrigin } from '../services/duskPreviewOrigins';
/** Exact browser origins; comma-separated configuration supports release previews. */
export function corsOrigins(
  value = process.env.CORS_ORIGIN || '*',
): string | string[] {
  const origins = [
    ...new Set(
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
    ),
  ];
  if (origins.includes('*') && origins.length !== 1) {
    throw new Error('CORS wildcard cannot be combined with explicit origins');
  }
  return origins.length === 1 ? origins[0] : origins;
}

export function allowsOrigin(
  configured: string | string[],
  origin?: string,
): boolean {
  return (
    !origin ||
    configured === '*' ||
    (Array.isArray(configured)
      ? configured.includes(origin)
      : configured === origin)
  );
}

/** Dynamic admission is restricted to authenticated, owned deployment records. */
export async function allowsBrowserOrigin(
  configured: string | string[],
  origin?: string,
): Promise<boolean> {
  return (
    allowsOrigin(configured, origin) ||
    (typeof origin === 'string' && (await allowsPreviewOrigin(origin)))
  );
}
export function browserOriginCallback(configured: string | string[]) {
  return (
    origin: string | undefined,
    done: (error: Error | null, allowed?: boolean) => void,
  ): void => {
    void allowsBrowserOrigin(configured, origin)
      .then((allowed) => done(null, allowed))
      .catch(() => done(null, false));
  };
}
