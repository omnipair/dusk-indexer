import { readFileSync } from 'node:fs';

export interface KmsIdentity {
  readonly keyArn: string;
  readonly publicKey: string;
}

export interface ReleaseConfig {
  readonly account: string;
  readonly primaryRegion: string;
  readonly indexerRegion: string;
  readonly apiCertificateArn: string;
  readonly browserOrigins?: readonly string[];
  readonly kms: Readonly<Record<string, KmsIdentity>>;
}

export interface ServiceSpec {
  readonly name: string;
  readonly replicas: number;
  readonly sourcePublicSettings: Readonly<Record<string, string>>;
  readonly entrypoint: string | null;
}

export interface ParitySpec {
  readonly services: readonly ServiceSpec[];
  readonly database: { readonly pinnedImage: string };
  readonly sizing: { readonly services: Readonly<Record<string, {
    readonly vcpu: number;
    readonly memoryGiB: number;
  }>> };
}

export const SIGNING_PROFILES = ['lending', 'leverage', 'hlp-recovery', 'auction-arbitrage', 'lifecycle'] as const;

export function loadParity(): ParitySpec {
  return JSON.parse(readFileSync(new URL('../../railway-parity.json', import.meta.url), 'utf8')) as ParitySpec;
}

export function validateConfig(config: ReleaseConfig): void {
  if (!/^\d{12}$/.test(config.account)) throw new Error('Expected AWS account ID');
  if (config.primaryRegion !== 'ap-southeast-1' || config.indexerRegion !== 'us-west-2')
    throw new Error('Compute regions must match the captured Railway locations');
  if (!config.apiCertificateArn.startsWith(`arn:aws:acm:${config.primaryRegion}:${config.account}:certificate/`))
    throw new Error('API certificate must belong to the primary region and account');
  if (config.browserOrigins && (!config.browserOrigins.length || config.browserOrigins.some(origin => {
    try { const url = new URL(origin); return url.protocol !== 'https:' || url.origin !== origin; }
    catch { return true; }
  }))) throw new Error('Browser origins must be exact HTTPS origins');
  const keys = new Set<string>(), wallets = new Set<string>();
  for (const profile of SIGNING_PROFILES) {
    const identity = config.kms[profile];
    if (!identity || !identity.keyArn.startsWith(`arn:aws:kms:us-east-1:${config.account}:key/`)
      || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(identity.publicKey))
      throw new Error(`Invalid public KMS identity for ${profile}`);
    keys.add(identity.keyArn); wallets.add(identity.publicKey);
  }
  if (keys.size !== 5 || wallets.size !== 5 || Object.keys(config.kms).length !== 5)
    throw new Error('Each signing worker requires one distinct KMS key and wallet');
}
