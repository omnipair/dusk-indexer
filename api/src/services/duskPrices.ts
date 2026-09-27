/**
 * Saved preview price captures, from before prices came from swap snapshots
 * events. Only archived quote history reads them; nothing writes new ones.
 */
import { nativeFields } from './duskPortfolioMath';
import { unsigned } from './duskYieldAccounting';
import { BorshCoder, Idl } from '@coral-xyz/anchor';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { canonicalJson, DuskPinnedProtocol, loadPinnedProtocol, sha256 } from '../config/duskProtocol';
import { projectMarketPrices } from './duskPriceMath';

const identity = (pin = loadPinnedProtocol()) => {
  return [pin.cluster,pin.dusk.programId,pin.dusk.idlCanonicalSha256,pin.revision];
};
const protocolRoot = () => process.env.DUSK_PROTOCOL_DIR?.trim() || resolve(__dirname,'../../../protocol');
function idl(): Idl {
  const pin = loadPinnedProtocol();
  const raw = readFileSync(resolve(protocolRoot(),'idl/dusk.json'),'utf8');
  if (sha256(raw) !== pin.dusk.idlRawSha256) throw new Error('Price decoder IDL differs from the active protocol pin');
  return JSON.parse(raw) as Idl;
}
// The checked IDL is immutable for this process, just like loadPinnedProtocol.
// Reuse only decoding layouts: every observation is still hashed, decoded and
// verified against its saved source on every read. No prices/results are cached.
let decoder: BorshCoder | undefined;
function priceDecoder(): BorshCoder {
  return decoder ??= new BorshCoder(idl());
}
export interface PriceCaptureSource {
  market: string; slot: number; marketSlot: number; blockhash: string; blockTime: string; observedAt: string;
  deploymentIdentitySha256: string; rawMarket: string; rawPreview: string; references: unknown;
  marketStateBasis?: 'simulation-post-state';
}
function hashSource(source: PriceCaptureSource,pin = loadPinnedProtocol()): string {
  // Repeat observations of identical bank bytes retain their first capture.
  const { observedAt: _observedAt,...durable } = source;
  return sha256(canonicalJson([identity(pin),durable]));
}
function bytes(value: string): Buffer {
  const result = Buffer.from(value,'base64');
  if (!result.length || result.toString('base64') !== value) throw new Error('Invalid price source bytes');
  return result;
}
export interface StoredPriceCapture {
  cluster: string; program_id: string; idl_hash: string; protocol_revision: string;
  capture_id: string; market: string; slot: string; market_slot: string; blockhash: string;
  block_time: Date; observed_at: Date; deployment_identity_sha256: string;
  raw_market: Buffer; raw_preview: Buffer; reference_config: unknown; market_state_basis: string;
  content_hash: string; preview_hash: string;
}

/** Rebuild historical price evidence from its immutable saved bytes/policy. */
export function verifyStoredPriceCapture(row: StoredPriceCapture,release?: {pin: DuskPinnedProtocol; coder: BorshCoder}) {
  const pin = release?.pin ?? loadPinnedProtocol();
  if (JSON.stringify([row.cluster,row.program_id,row.idl_hash,row.protocol_revision]) !== JSON.stringify(identity(pin))
    || !['rpc-account','simulation-post-state'].includes(row.market_state_basis)) throw new Error('Price capture differs from the active protocol identity');
  const source: PriceCaptureSource = { market: row.market,slot: Number(row.slot),marketSlot: Number(row.market_slot),blockhash: row.blockhash,
    blockTime: row.block_time.toISOString(),observedAt: row.observed_at.toISOString(),deploymentIdentitySha256: row.deployment_identity_sha256,
    rawMarket: row.raw_market.toString('base64'),rawPreview: row.raw_preview.toString('base64'),references: row.reference_config,
    ...(row.market_state_basis === 'simulation-post-state' ? { marketStateBasis: 'simulation-post-state' as const } : {}) };
  if (!Number.isSafeInteger(source.slot) || !Number.isSafeInteger(source.marketSlot) || source.marketSlot<0 || source.slot<source.marketSlot
    || source.marketStateBasis === 'simulation-post-state' && source.slot !== source.marketSlot
    || Date.parse(source.observedAt)<Date.parse(source.blockTime) || hashSource(source,pin) !== row.content_hash
    || sha256(row.raw_preview) !== row.preview_hash) throw new Error('FINALIZED_INVARIANT: saved price source hash mismatch');
  const coder = release?.coder ?? priceDecoder();
  const preview = nativeFields(coder.types.decode('MarketPreview',row.raw_preview));
  const oraclePrices = { base: unsigned(nativeFields(preview.base).price_ema_nad, (1n<<64n)-1n).toString(),
    quote: unsigned(nativeFields(preview.quote).price_ema_nad, (1n<<64n)-1n).toString() };
  const projected = projectMarketPrices({ pin,marketAddress: source.market,market: coder.accounts.decode('Market',row.raw_market),
    preview,slot: source.slot,blockTime: source.blockTime,references: source.references });
  return { source,projected,oraclePrices };
}
