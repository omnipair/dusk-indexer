import { Connection, PublicKey, SYSVAR_CLOCK_PUBKEY } from '@solana/web3.js';
import { duskApiConfig, DUSK_DEPLOYMENT_COMMITMENT } from '../config/duskProtocol';
import mock from '../config/oracles/devnet-mock.json';

export const MOCK_REPORT_BYTES = 145;
const U64 = (1n << 64n) - 1n;
export function oracleCatalogPair(base: unknown, quote: unknown) {
  const canonical = (value: unknown) => {
    try {
      if (typeof value !== 'string' || new PublicKey(value).toBase58() !== value) throw new Error();
      return value;
    } catch { throw Object.assign(new Error('A canonical mint address is required'), { status: 400 }); }
  };
  const baseMint = canonical(base), quoteMint = canonical(quote);
  if (baseMint === quoteMint) throw Object.assign(new Error('Choose two different mints'), { status: 400 });
  return { baseMint, quoteMint };
}

/** Test feed matches exact cluster AND ordered mints. Symbols never establish identity. */
export function catalogSources(network: string, baseMint: string, quoteMint: string) {
  return network === 'devnet' && baseMint === mock.baseMint && quoteMint === mock.quoteMint ? [mock] : [];
}

export function decodeMockReport(data: Buffer, owner: string, now: { slot: bigint; unix: bigint }) {
  if (data.length !== MOCK_REPORT_BYTES || owner !== mock.programId || data.subarray(0, 8).toString() !== 'DOPRV001'
      || data.subarray(8, 40).toString('hex') !== mock.feedId
      || new PublicKey(data.subarray(40, 72)).toBase58() !== mock.baseMint
      || new PublicKey(data.subarray(72, 104)).toBase58() !== mock.quoteMint) throw new Error('Mock report authentication failed');
  const price = data.readBigUInt64LE(104), confidence = data.readBigUInt64LE(112);
  const time = data.readBigInt64LE(120), slot = data.readBigUInt64LE(128), sequence = data.readBigUInt64LE(136);
  if (!price || confidence >= price || !sequence || time < 0n || time > now.unix || slot > now.slot || now.slot > U64)
    throw new Error('Invalid mock observation');
  const status = data[144] !== 1 ? 'invalid' : now.unix - time > 60n || now.slot - slot > 150n ? 'stale' : 'fresh';
  return { status, priceNad: price.toString(), confidenceNad: confidence.toString(),
    publishTime: time.toString(), publishSlot: slot.toString(), sequence: sequence.toString() };
}

export async function oracleFeedCatalog(base: unknown, quote: unknown, minimumSlot: number) {
  const pair = oracleCatalogPair(base, quote), config = duskApiConfig();
  const sources = catalogSources(config.network, pair.baseMint, pair.quoteMint);
  const connection = new Connection(config.rpcUrl, DUSK_DEPLOYMENT_COMMITMENT);
  const snapshot = sources.length ? await connection.getMultipleAccountsInfoAndContext(
    [new PublicKey(mock.report), SYSVAR_CLOCK_PUBKEY], { commitment: DUSK_DEPLOYMENT_COMMITMENT, minContextSlot: minimumSlot },
  ) : null;
  const clock = snapshot?.value[1]?.data;
  if (snapshot && (!clock || clock.length < 40)) throw new Error('Oracle catalog clock unavailable');
  const now = clock ? { slot: clock.readBigUInt64LE(0), unix: clock.readBigInt64LE(32) } : null;
  const feeds = sources.map(source => {
    let report: Record<string, unknown> = { status: 'unavailable', priceNad: null, confidenceNad: null, publishTime: null, publishSlot: null, sequence: null };
    const account = snapshot!.value[0];
    if (account && now) {
      try { report = decodeMockReport(account.data, account.owner.toBase58(), now); }
      catch { report = { ...report, status: 'invalid' }; }
    }
    return { id: 'devnet-meta-usdc', name: 'META / USDC test feed', providerKind: 'mock', providerLabel: 'Devnet mock',
      ...source, format: 'normalized', provider: source.programId, baseAccount: source.report, quoteAccount: null,
      baseFeedId: source.feedId, quoteFeedId: null, ...report,
      maxAgeSeconds: 60, maxAgeSlots: '150',
      description: 'Centralized synthetic price for these devnet mock mints. No external market data.',
    };
  });
  const sourceSlot = snapshot?.context.slot ?? minimumSlot;
  return { data: { schemaVersion: 'dusk-oracle-catalog.v1', network: config.network, ...pair,
    sourceSlot, observedAt: now ? new Date(Number(now.unix) * 1000).toISOString() : new Date().toISOString(), feeds }, sourceSlot };
}
