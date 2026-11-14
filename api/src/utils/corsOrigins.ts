/** Exact browser origins; comma-separated configuration supports release previews. */
export function corsOrigins(value = process.env.CORS_ORIGIN || '*'): string | string[] {
  const origins = [...new Set(value.split(',').map(origin => origin.trim()).filter(Boolean))];
  if (origins.includes('*') && origins.length !== 1) {
    throw new Error('CORS wildcard cannot be combined with explicit origins');
  }
  return origins.length === 1 ? origins[0] : origins;
}

export function allowsOrigin(configured: string | string[], origin?: string): boolean {
  return !origin || configured === '*' || (Array.isArray(configured)
    ? configured.includes(origin) : configured === origin);
}
