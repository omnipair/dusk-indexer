import { PublicKey } from '@solana/web3.js';
import { canonicalJson, DuskPinnedProtocol, sha256 } from '../config/duskProtocol';
import { unsigned } from './duskYieldAccounting';

export interface PriceReference { mint: string; priceUsd: string; note: string }
export interface PriceReferences {
  schemaVersion: 'dusk-price-references.v1'; cluster: string; programId: string; idlSha256: string; protocolRevision: string;
  effectiveFrom: string; references: PriceReference[];
}
const fields = (value: unknown): Record<string,unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Missing price source fields');
  return value as Record<string,unknown>;
};
function key(value: unknown): string {
  const text = value instanceof PublicKey ? value.toBase58() : value;
  if (typeof text !== 'string' || new PublicKey(text).toBase58() !== text) throw new Error('Invalid price source mint');
  return text;
}
export function positiveDecimal(value: unknown): string {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,99})(\.[0-9]{1,36})?$/.test(value)) throw new Error('Price must be a positive decimal string');
  const normalized = value.includes('.') ? value.replace(/0+$/,'').replace(/\.$/,'') : value;
  if (normalized === '0') throw new Error('Price must be positive');
  return normalized;
}
export function parsePriceReferences(value: unknown, pin: DuskPinnedProtocol): PriceReferences {
  const data = fields(value);
  if (data.schemaVersion !== 'dusk-price-references.v1' || data.cluster !== pin.cluster || data.programId !== pin.dusk.programId
    || data.idlSha256 !== pin.dusk.idlCanonicalSha256 || data.protocolRevision !== pin.revision)
    throw new Error('Price references differ from the active protocol identity');
  if (typeof data.effectiveFrom !== 'string' || !Number.isFinite(Date.parse(data.effectiveFrom)) || !Array.isArray(data.references))
    throw new Error('Invalid dated price references');
  const seen = new Set<string>();
  const references = data.references.map((value) => {
    const ref = fields(value),mint = key(ref.mint),priceUsd = positiveDecimal(ref.priceUsd);
    if (seen.has(mint)) throw new Error('Duplicate configured price reference');
    seen.add(mint);
    if (typeof ref.note !== 'string' || !ref.note.trim()) throw new Error('Configured prices require a source note');
    return { mint,priceUsd,note: ref.note.trim() };
  }).sort((a,b) => a.mint.localeCompare(b.mint));
  return { schemaVersion: 'dusk-price-references.v1',cluster: pin.cluster,programId: pin.dusk.programId,
    idlSha256: pin.dusk.idlCanonicalSha256,protocolRevision: pin.revision,effectiveFrom: new Date(data.effectiveFrom).toISOString(),references };
}

/** Exact integer arithmetic, with derived quotes rounded down to 36 decimals. */
export function multiplyPriceRatio(price: string, numerator: bigint, denominator: bigint): string {
  if (numerator<=0n || denominator<=0n) throw new Error('Price ratio must be positive');
  const [whole,fraction=''] = positiveDecimal(price).split('.');
  const units = BigInt(whole+fraction)*numerator*10n**BigInt(36-fraction.length)/denominator;
  const formatted = `${units/10n**36n}.${(units%10n**36n).toString().padStart(36,'0')}`;
  return positiveDecimal(formatted);
}

export function priceMarketBindings(programId: string, address: string, value: unknown) {
  const market = fields(value),base = fields(market.base_side),quote = fields(market.quote_side);
  const baseMint = key(base.asset_mint),quoteMint = key(quote.asset_mint),paramsHash = market.params_hash;
  if (baseMint === quoteMint || !Array.isArray(paramsHash) || paramsHash.length !== 32
    || paramsHash.some((byte) => !Number.isInteger(byte) || byte<0 || byte>255)) throw new Error('Invalid market price bindings');
  const [derived,bump] = PublicKey.findProgramAddressSync([Buffer.from('market_v2'),new PublicKey(baseMint).toBuffer(),
    new PublicKey(quoteMint).toBuffer(),Buffer.from(paramsHash)],new PublicKey(programId));
  if (derived.toBase58() !== address || unsigned(market.bump,255n) !== BigInt(bump)) throw new Error('Price source market PDA mismatch');
  return { baseMint,quoteMint,baseDecimals: Number(unsigned(base.asset_decimals,255n)),quoteDecimals: Number(unsigned(quote.asset_decimals,255n)) };
}

export function projectMarketPrices(input: {
  pin: DuskPinnedProtocol; marketAddress: string; market: unknown; preview: unknown; slot: number; blockTime: string; references: unknown;
}) {
  const references = parsePriceReferences(input.references,input.pin),preview = fields(input.preview);
  const bound = priceMarketBindings(input.pin.dusk.programId,input.marketAddress,input.market);
  if (!Number.isSafeInteger(input.slot) || input.slot<0 || unsigned(preview.slot,(1n<<64n)-1n) !== BigInt(input.slot))
    throw new Error('Price preview does not belong to the observed bank');
  const time = Date.parse(input.blockTime);
  if (!Number.isFinite(time)) throw new Error('Invalid price source block time');
  const referenceHash = sha256(canonicalJson(references));
  // Both sides are decimal-normalized program quotes, including markets for
  // which no USD reference exists. A zero quote is unavailable, not $0.
  const spotPrices = {
    base: unsigned(fields(preview.base).spot_price_nad,(1n<<64n)-1n).toString(),
    quote: unsigned(fields(preview.quote).spot_price_nad,(1n<<64n)-1n).toString(),
  };
  const available = time >= Date.parse(references.effectiveFrom) ? references.references : [];
  const byMint = new Map(available.map((reference) => [reference.mint,reference]));
  const prices = [];
  for (const side of ['base','quote'] as const) {
    const mint = side === 'base' ? bound.baseMint : bound.quoteMint;
    const otherMint = side === 'base' ? bound.quoteMint : bound.baseMint;
    const own = byMint.get(mint),other = byMint.get(otherMint);
    if (!own && !other) continue;
    // The program's curve-aware quote already normalizes token decimals.
    const spotPriceNad = BigInt(spotPrices[side]);
    const reference = own ?? other!;
    prices.push({ mint,decimals: side === 'base' ? bound.baseDecimals : bound.quoteDecimals,
      priceUsd: own ? own.priceUsd : multiplyPriceRatio(reference.priceUsd,spotPriceNad,1_000_000_000n),
      quality: own ? 'configured-reference' as const : 'derived-reference' as const,
      reference,spotPriceNad: own ? null : spotPriceNad.toString() });
  }
  return { prices,referenceHash,bound,spotPrices };
}
